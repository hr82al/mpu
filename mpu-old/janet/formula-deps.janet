# formula-deps.janet — walk a formula AST and recursively trace every
# dependency back to direct values, empty cells, or cycle stops.
#
# Layered alongside formula-parser (AST) and formula-finder (cell lookup).
# Loaded at VM boot via loadJanetScripts.
#
# Exposed API:
#   (formula-deps/extract-refs ast)
#     → @[[:ref "A1"] [:range "A1" "B2"] [:range-ref "A1" "B2"] …]
#
#   (formula-deps/expand-range l r &opt merged)
#     → @["A1" "A2" …]                        (row-major; merged bounds
#                                               open-ended refs like A:A)
#
#   (formula-deps/trace merged addr &opt visited analysis-row)
#     → recursive tree:
#       {:addr "A1"        :kind :direct    :value v}
#       {:addr "Z9"        :kind :empty}
#       {:addr "B1"        :kind :formula   :src "B1" :formula "=…"
#        :children [...]}
#       {:addr "T6"        :kind :cycle     :src "R4" :formula "=…"}
#       {:addr "X!A1"      :kind :external}
#       {:addr "$A$4:$ZY"  :kind :range-ref}   ← lookup/LAMBDA range, not expanded
#       {:addr "$A$4:$ZY"  :kind :range-ref :row 20 :cells [...]}
#         ← when analysis-row is given, cells of that row inside the range are
#           attached as leaf children (:direct value or :formula src/formula).

# ── small helpers (private) ────────────────────────────────────────

(def- C-A (chr "A"))
(def- C-Z (chr "Z"))
(def- C-0 (chr "0"))
(def- C-9 (chr "9"))

(defn- -upper? [c] (and c (>= c C-A) (<= c C-Z)))
(defn- -digit? [c] (and c (>= c C-0) (<= c C-9)))

(defn- -strip-dollars [s]
  (def b @"")
  (each c s (unless (= c (chr "$")) (buffer/push-byte b c)))
  (string b))

(defn- -split-sheet [text]
  # "Sheet!A1" → ["Sheet" "A1"]; "A1" → [nil "A1"].
  (def bang (string/find "!" text))
  (if bang
    [(string/slice text 0 bang) (string/slice text (+ bang 1))]
    [nil text]))

(defn- -split-addr [addr]
  # "AA100" → ["AA" 100]; "A" → ["A" nil]; "10" → [nil 10].
  (def n (length addr))
  (var i 0)
  (while (and (< i n) (-upper? (get addr i))) (++ i))
  (def letters (if (pos? i) (string/slice addr 0 i)))
  (def digits  (if (< i n) (scan-number (string/slice addr i))))
  [letters digits])

(defn- -col-index [letters]
  (var col 0)
  (each c letters (set col (+ (* col 26) (- c C-A) 1)))
  col)

(defn- -col-letters [col]
  (def b @"")
  (var c col)
  (while (pos? c)
    (def rem (mod (- c 1) 26))
    (buffer/push-byte b (+ C-A rem))
    (set c (div (- c 1) 26)))
  (string/reverse (string b)))

(defn- -addr-str [col row] (string (-col-letters col) row))

(defn- -merged-bounds [merged]
  # Return [max-row max-col] by scanning present cell addresses.
  (var mr 0)
  (var mc 0)
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (when-let [a (get cell "a")]
          (def ok (protect (formula-finder/cell->rc a)))
          (when (get ok 0)
            (def [r c] (get ok 1))
            (when (> r mr) (set mr r))
            (when (> c mc) (set mc c)))))))
  [mr mc])

# Key for dedup in extract-refs.
# :ref and :range share "r:"/"R:" prefixes.
# :range-ref uses "RR:" so the same range can appear as both an aggregate
# (:range, fully expanded) and a lookup-table reference (:range-ref, leaf).
(defn- -ref-key [node]
  (case (get node 0)
    :ref       (string "r:"  (get node 1))
    :range     (string "R:"  (get node 1) ":" (get node 2))
    :range-ref (string "RR:" (get node 1) ":" (get node 2))
    nil))

# ── extract-refs ──────────────────────────────────────────────────

# Functions that use a range as a lookup/selector table, not as a set of
# values to aggregate.  Range arguments to these functions are emitted as
# :range-ref (visible leaf, not expanded) because we cannot statically
# determine which specific cells are accessed.  Non-range arguments
# (keys, indices) are still walked normally.
(def- -lookup-fns
  (tabseq [f :in ["INDEX" "VLOOKUP" "HLOOKUP" "XLOOKUP"
                  "MATCH" "XMATCH"
                  "CHOOSECOLS" "CHOOSEROWS"
                  "FILTER" "SORT" "SORTBY"
                  "UNIQUE" "TRANSPOSE"
                  "KEYSQUERY" "CL_QUERY" "SQL_DATE"]]
    f true))

(defn formula-deps/extract-refs
  "Walk `ast` and return an array of [:ref a] / [:range l r] / [:range-ref l r]
   nodes in traversal order, each type deduped independently.

   :range-ref means 'this range is referenced but not aggregated — show it as
   a leaf in the dependency tree without recursing into its cells'.

   Two rules prevent combinatorial blowup on large spreadsheets:

   1. LAMBDA bodies are walked shallowly: ranges are collected as :range-ref
      (so they appear in the tree), but single-cell refs and nested calls
      are not expanded.  A LAMBDA is a function definition; its body runs
      with different bindings at each call site, so its ranges are
      informational dependencies, not direct cell deps.

   2. Lookup-function range args (INDEX data-range, MATCH lookup-range,
      VLOOKUP table-range, KEYSQUERY header/data …) are emitted as :range-ref.
      Non-range args (keys, indices) are walked normally so that, e.g., the
      key cell in VLOOKUP(A1; …) is traced as a real dependency."
  [ast]
  (def out  @[])
  (def seen @{})
  (defn- push [node]
    (def k (-ref-key node))
    (unless (or (nil? k) (get seen k))
      (put seen k true)
      (array/push out node)))
  # Shallow walk that only harvests :range nodes, emitting them as :range-ref.
  # Used for LAMBDA bodies to show what ranges the lambda reads without
  # triggering full expansion.
  (defn- collect-range-refs [node]
    (when (indexed? node)
      (case (get node 0)
        :range (push [:range-ref (get node 1) (get node 2)])
        :unop    (collect-range-refs (get node 2))
        :postfix (collect-range-refs (get node 2))
        :binop   (do (collect-range-refs (get node 2))
                     (collect-range-refs (get node 3)))
        :call    (each a (get node 2) (collect-range-refs a))
        :array   (each a (get node 1) (collect-range-refs a))
        :matrix  (each row (get node 1) (each a row (collect-range-refs a))))))
  (defn- walk [node]
    (when (indexed? node)
      (case (get node 0)
        :ref   (push node)
        :range (push node)
        :unop    (walk (get node 2))
        :postfix (walk (get node 2))
        :binop   (do (walk (get node 2)) (walk (get node 3)))
        :call
        (let [fname (get node 1)
              args  (get node 2)]
          (cond
            # LAMBDA: parametric body — collect ranges as :range-ref, don't
            # recurse further (avoids expanding huge open-ended lookup tables).
            (= fname "LAMBDA")
            (collect-range-refs node)
            # Lookup functions: range args → :range-ref leaves;
            # non-range args (keys, indices) → full walk.
            (get -lookup-fns fname)
            (each a args
              (if (and (indexed? a) (= (get a 0) :range))
                (push [:range-ref (get a 1) (get a 2)])
                (walk a)))
            # Default: walk all args.
            (each a args (walk a))))
        :array   (each a (get node 1) (walk a))
        :matrix  (each row (get node 1) (each a row (walk a))))))
  (walk ast)
  out)

# ── expand-range ──────────────────────────────────────────────────

(defn formula-deps/expand-range
  "Enumerate the rectangle bounded by `l` and `r` (A1-style, possibly
   with $ markers) as row-major cell addresses. `merged` is optional but
   required for open-ended refs (A:A, 1:1) so we can derive bounds from
   the sheet's occupied area. Cross-sheet prefixes are stripped."
  [l r &opt merged]
  (def [_ la] (-split-sheet l))
  (def [_ ra] (-split-sheet r))
  (def a1 (-strip-dollars la))
  (def a2 (-strip-dollars ra))
  (def [l1 d1] (-split-addr a1))
  (def [l2 d2] (-split-addr a2))
  (def [mr mc] (if merged (-merged-bounds merged) [0 0]))
  (def c1 (cond l1 (-col-index l1) l2 (-col-index l2) 1))
  (def c2 (cond l2 (-col-index l2) l1 (-col-index l1) (max c1 mc)))
  (def r1 (or d1 d2 1))
  (def r2 (or d2 d1 (max r1 mr)))
  (def out @[])
  (for r (min r1 r2) (+ (max r1 r2) 1)
    (for c (min c1 c2) (+ (max c1 c2) 1)
      (array/push out (-addr-str c r))))
  out)

# ── cells-in-range ────────────────────────────────────────────────

(defn- formula-deps/cells-in-range
  "Return cells from merged whose address falls within the rectangle
   defined by l and r (A1-style, possibly with $ markers and sheet prefix).
   Open-ended endpoints (column name without row, e.g. ZY in $A$4:$ZY)
   are treated as unbounded on that row axis.
   Returns an array of cell tables sorted in row-major order.

   This avoids expanding huge ranges to individual addresses — only cells
   that actually carry data in merged are returned."
  [merged l r]
  (def [_ la] (-split-sheet l))
  (def [_ ra] (-split-sheet r))
  (def a1 (-strip-dollars la))
  (def a2 (-strip-dollars ra))
  (def [l1 d1] (-split-addr a1))
  (def [l2 d2] (-split-addr a2))
  # Column bounds
  (def c1 (cond l1 (-col-index l1) l2 (-col-index l2) 1))
  (def c2 (cond l2 (-col-index l2) l1 (-col-index l1) c1))
  (def min-c (min c1 c2))
  (def max-c (max c1 c2))
  # Row bounds — nil means that end is open/unbounded
  (def min-r (cond (and d1 d2) (min d1 d2)  d1 d1  d2 d2  1))
  (def max-r (cond (and d1 d2) (max d1 d2)  nil))
  (def out @[])
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (when-let [a (get cell "a")]
          (def ok (protect (formula-finder/cell->rc a)))
          (when (get ok 0)
            (def [cr cc] (get ok 1))
            (when (and (>= cr min-r)
                       (or (nil? max-r) (<= cr max-r))
                       (>= cc min-c)
                       (<= cc max-c))
              (array/push out [cr cc cell])))))))
  # Sort by (row, col) so iteration is deterministic and row-major
  (sort-by |(+ (* (get $ 0) 100000) (get $ 1)) out)
  (map |(get $ 2) out))

# ── trace ────────────────────────────────────────────────────────

(defn- -external? [addr] (not (nil? (string/find "!" addr))))

(defn formula-deps/trace
  "Recursively trace the value origin of `addr` inside `merged`. Returns
   a tree (see module comment). `visited` is a set of formula source
   addresses already on the walk path — used for cycle detection and
   shared across siblings so repeated spilled cells don't blow up.

   `analysis-row`, when given, annotates same-sheet :range-ref leaves with
   the cells from that row that fall inside the range — rendered as leaves
   (direct value or formula home, no deep recursion), so the user can see
   which concrete cells a lookup range resolves to for the target row.

   Range handling:
   - :range refs that are cross-sheet → :external leaf (not expanded).
   - :range refs that are same-sheet  → cells-in-range lazy scan, unique
     formula homes traced once each.
   - :range-ref (lookup tables, LAMBDA body ranges) → leaf node, never
     expanded regardless of sheet (but may carry row-restricted :cells when
     analysis-row is supplied)."
  [merged addr &opt visited analysis-row]
  (default visited @{})
  (cond
    (-external? addr)
    @{:addr addr :kind :external}

    (let [r (formula-finder/resolve merged addr)]
      (cond
        (nil? r)
        @{:addr addr :kind :empty}

        (= (get r 0) :direct)
        @{:addr addr :kind :direct :value (get r 2)}

        (= (get r 0) :formula)
        (let [src     (get r 1)
              formula (get r 2)]
          (if (get visited src)
            @{:addr addr :kind :cycle :src src :formula formula}
            (let [_        (put visited src true)
                  parsed   (protect (formula-parser/parse formula))
                  ast-ok?  (get parsed 0)
                  refs     (if ast-ok?
                             (formula-deps/extract-refs (get parsed 1))
                             @[])
                  children @[]]
              (each ref refs
                (case (get ref 0)
                  :ref
                  (array/push children
                    (formula-deps/trace merged (get ref 1) visited analysis-row))

                  :range
                  # Cross-sheet range → :external leaf.
                  # Same-sheet range → lazy expand via cells-in-range,
                  # trace each unique formula home exactly once.
                  (let [rl (get ref 1)
                        rr (get ref 2)
                        [lsheet _] (-split-sheet rl)]
                    (if lsheet
                      (array/push children
                        @{:addr (string rl ":" rr) :kind :external})
                      (let [rcells (formula-deps/cells-in-range merged rl rr)
                            rseen  @{}]
                        (each cell rcells
                          (def a (get cell "a"))
                          (def res (formula-finder/resolve merged a))
                          (def home
                            (cond
                              (nil? res) a
                              (= (get res 0) :formula) (get res 1)
                              a))
                          (unless (get rseen home)
                            (put rseen home true)
                            (array/push children
                              (formula-deps/trace merged home visited analysis-row)))))))

                  :range-ref
                  # Informational reference: lookup-table range or LAMBDA body range.
                  # Rendered as a leaf — cross-sheet → :external, same-sheet → :range-ref.
                  # Individual cells are NOT recursively traced, but when
                  # analysis-row is set we attach the row's cells as leaf
                  # nodes so the caller can see concrete values.
                  (let [rl (get ref 1)
                        rr (get ref 2)
                        [lsheet _] (-split-sheet rl)
                        raddr (string rl ":" rr)]
                    (cond
                      lsheet
                      (array/push children
                        @{:addr raddr :kind :external})

                      (nil? analysis-row)
                      (array/push children
                        @{:addr raddr :kind :range-ref})

                      (let [rcells (formula-deps/cells-in-range merged rl rr)
                            row-cells
                              (filter
                                (fn [c]
                                  (def a (get c "a"))
                                  (def ok (protect (formula-finder/cell->rc a)))
                                  (and (get ok 0)
                                       (= analysis-row (get (get ok 1) 0))))
                                rcells)
                            cell-nodes @[]
                            seen-homes @{}]
                        (each c row-cells
                          (def a (get c "a"))
                          (def cf (get c "f"))
                          (def cv (get c "v"))
                          # Read formula/value directly from the cell — avoids
                          # calling find-source (O(n_cells)) for every row cell.
                          (cond
                            (and (string? cf) (not (empty? cf)))
                            (unless (get seen-homes a)
                              (put seen-homes a true)
                              (array/push cell-nodes
                                @{:addr a
                                  :kind :formula
                                  :src a
                                  :formula cf
                                  :children @[]}))
                            (not (nil? cv))
                            (array/push cell-nodes
                              @{:addr a
                                :kind :direct
                                :value cv})))
                        (if (empty? cell-nodes)
                          (array/push children
                            @{:addr raddr :kind :range-ref})
                          (array/push children
                            @{:addr raddr
                              :kind :range-ref
                              :row analysis-row
                              :cells cell-nodes})))))))

              (def node
                @{:addr addr :kind :formula :src src :formula formula
                  :children children})
              (unless ast-ok?
                (put node :parse-error (get parsed 1)))
              node))))
    )))
