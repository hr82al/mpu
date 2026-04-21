# Pure-logic tests for formula-deps — reference extraction, range
# expansion, and recursive dependency tracing through batch-get-all data.
#
# Runs inside an mpu VM via loadJanetScripts (no explicit import).
#
#   mpu repl janet/tests/formula-deps_test.janet
#
# Each (assert ...) raises on failure; `make test` exits non-zero.

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT!A1:ZZ999" "values" cells})

# ── extract-refs: leaves ────────────────────────────────────────

(assert (empty? (formula-deps/extract-refs [:num 42]))
        "number has no refs")
(assert (empty? (formula-deps/extract-refs [:str "hi"]))
        "string has no refs")
(assert (empty? (formula-deps/extract-refs [:bool true]))
        "bool has no refs")
(assert (empty? (formula-deps/extract-refs [:empty]))
        ":empty has no refs")
(assert (empty? (formula-deps/extract-refs [:name "Foo"]))
        ":name (named range) is not a cell ref")

(assert (deep= @[[:ref "A1"]]
               (formula-deps/extract-refs [:ref "A1"]))
        "single cell ref")
(assert (deep= @[[:range "A1" "B2"]]
               (formula-deps/extract-refs [:range "A1" "B2"]))
        "range literal preserved as-is")

# ── extract-refs: recursion through operators & calls ──────────

(assert (deep= @[[:ref "A1"]]
               (formula-deps/extract-refs [:unop "-" [:ref "A1"]]))
        "unop walked")
(assert (deep= @[[:ref "A1"]]
               (formula-deps/extract-refs [:postfix "%" [:ref "A1"]]))
        "postfix walked")
(assert (deep= @[[:ref "A1"] [:ref "B2"]]
               (formula-deps/extract-refs
                 [:binop "+" [:ref "A1"] [:ref "B2"]]))
        "binop: both sides")
(assert (deep= @[[:range "A1" "A3"]]
               (formula-deps/extract-refs
                 [:call "SUM" [[:range "A1" "A3"]]]))
        "call: range arg")
(assert (deep= @[[:ref "A1"] [:ref "B2"] [:ref "C3"]]
               (formula-deps/extract-refs
                 [:call "IF"
                        [[:binop ">" [:ref "A1"] [:num 0]]
                         [:ref "B2"]
                         [:ref "C3"]]]))
        "call: nested ref inside condition + branches")
(assert (deep= @[[:ref "A1"] [:ref "A2"]]
               (formula-deps/extract-refs
                 [:array [[:ref "A1"] [:ref "A2"]]]))
        "array literal walked")
(assert (deep= @[[:ref "A1"] [:ref "B2"]]
               (formula-deps/extract-refs
                 [:matrix [[[:ref "A1"]] [[:ref "B2"]]]]))
        "matrix walked row-major")

# Dedup: same ref twice collapses to one (avoids noisy trees).
(assert (deep= @[[:ref "A1"]]
               (formula-deps/extract-refs
                 [:binop "+" [:ref "A1"] [:ref "A1"]]))
        "duplicate refs deduped")

# ── expand-range: rectangle enumeration ────────────────────────

(assert (deep= @["A1" "A2" "A3"]
               (formula-deps/expand-range "A1" "A3" nil))
        "column range A1:A3")
(assert (deep= @["A1" "B1"]
               (formula-deps/expand-range "A1" "B1" nil))
        "row range A1:B1")
(assert (deep= @["A1" "B1" "A2" "B2"]
               (formula-deps/expand-range "A1" "B2" nil))
        "rectangle A1:B2 row-major")

# Reversed endpoints normalize to the same rectangle.
(assert (deep= @["A1" "B1" "A2" "B2"]
               (formula-deps/expand-range "B2" "A1" nil))
        "reversed endpoints normalize")

# $ markers stripped.
(assert (deep= @["A1" "A2"]
               (formula-deps/expand-range "$A$1" "$A$2" nil))
        "absolute markers stripped")

# Open-ended ranges (whole-column, whole-row) need merged for bounds.
(def merged-cols
  @[(range- @[
      @[(cell "A1" 1 "") (cell "B1" 2 "")]
      @[(cell "A2" 3 "") (cell "B2" 4 "")]])])

(assert (deep= @["A1" "A2"]
               (formula-deps/expand-range "A" "A" merged-cols))
        "whole-column A:A bounded by merged data")

# ── trace: direct value leaf ──────────────────────────────────

(def merged-direct
  @[(range- @[@[(cell "A1" 10 "")]])])

(def t-direct (formula-deps/trace merged-direct "A1"))
(assert (= :direct (get t-direct :kind))       "A1 is :direct")
(assert (= "A1"    (get t-direct :addr))       "addr preserved")
(assert (= 10      (get t-direct :value))      "value captured")
(assert (empty? (get t-direct :children @[]))  "leaf has no children")

# ── trace: empty cell ─────────────────────────────────────────

(def t-empty (formula-deps/trace merged-direct "Z99"))
(assert (= :empty (get t-empty :kind)) "absent cell is :empty")

# ── trace: simple formula → direct value ─────────────────────

(def merged-simple
  @[(range- @[
      @[(cell "A1" 10 "")]
      @[(cell "B1" 20 "=A1*2")]])])

(def t-simple (formula-deps/trace merged-simple "B1"))
(assert (= :formula (get t-simple :kind)) "B1 kind :formula")
(assert (= "=A1*2"  (get t-simple :formula)) "formula text captured")
(assert (= "B1"     (get t-simple :src)) "src addr captured")
(def kids-simple (get t-simple :children))
(assert (= 1 (length kids-simple)) "B1 has one child (A1)")
(assert (= "A1" (get (first kids-simple) :addr)) "child is A1")
(assert (= :direct (get (first kids-simple) :kind)) "A1 child is :direct")

# ── trace: nested formulas ────────────────────────────────────

(def merged-nested
  @[(range- @[
      @[(cell "A1" 5 "")]
      @[(cell "B1" 10 "=A1*2")]
      @[(cell "C1" 11 "=B1+1")]])])

(def t-nested (formula-deps/trace merged-nested "C1"))
(assert (= :formula (get t-nested :kind)) "C1 kind :formula")
(def c-kids (get t-nested :children))
(assert (= 1 (length c-kids)) "C1 has 1 dep (B1)")
(def b-node (first c-kids))
(assert (= "B1" (get b-node :addr)) "child is B1")
(assert (= :formula (get b-node :kind)) "B1 kind :formula")
(def b-kids (get b-node :children))
(assert (= 1 (length b-kids)) "B1 has 1 dep (A1)")
(assert (= "A1" (get (first b-kids) :addr)) "grandchild is A1")
(assert (= :direct (get (first b-kids) :kind)) "grandchild direct")

# ── trace: range expansion inside formula ────────────────────

(def merged-range
  @[(range- @[
      @[(cell "A1" 1 "") (cell "B1" 2 "")]
      @[(cell "A2" 3 "") (cell "B2" 4 "")]
      @[(cell "C1" 10 "=SUM(A1:B2)")]])])

(def t-range (formula-deps/trace merged-range "C1"))
(assert (= :formula (get t-range :kind)) "C1 :formula")
(def r-kids (get t-range :children))
(assert (= 4 (length r-kids)) "SUM(A1:B2) expands to 4 direct cells")
(def r-addrs (map |(get $ :addr) r-kids))
(assert (deep= @["A1" "B1" "A2" "B2"] r-addrs) "addrs in row-major order")
(each k r-kids (assert (= :direct (get k :kind)) "each range cell :direct"))

# ── trace: cycle detection (ARRAYFORMULA spills into its own input) ─

# ARRAYFORMULA(R4:T6+1) fills the 3×3 block R4:T6.
# Row 4 must include the spill cells S4 and T4 so that spill-width
# detection can determine the formula covers columns R..T (width 2).
(def merged-cycle
  @[(range- @[
      # Row 4: R4 = formula home; S4, T4 = spilled (no formula, have values).
      @[(cell "R4" 42  "=ARRAYFORMULA(R4:T6+1)")
        (cell "S4" 43  "")
        (cell "T4" 44  "")]
      # T6 = target (spill row 6, col T)
      @[(cell "T6" 100 "")]])])

(def t-cycle (formula-deps/trace merged-cycle "T6"))
(assert (= :formula (get t-cycle :kind)) "T6 resolves to R4 formula")
(assert (= "R4" (get t-cycle :src))      "src is R4")
# At least one child must be flagged :cycle — re-entering the same source.
(def cyc-kids (get t-cycle :children))
(def has-cycle
  (do (var found false)
      (each k cyc-kids
        (when (= :cycle (get k :kind)) (set found true)))
      found))
(assert has-cycle "at least one child marked :cycle")

# ── trace: cross-sheet ref marked :external ───────────────────

(def merged-ext
  @[(range- @[@[(cell "A1" 1 "=Other!B2")]])])

(def t-ext (formula-deps/trace merged-ext "A1"))
(def e-kids (get t-ext :children))
(assert (= 1 (length e-kids)) "one child")
(def e-node (first e-kids))
(assert (= :external (get e-node :kind)) "cross-sheet ref is :external")
(assert (= "Other!B2" (get e-node :addr)) "full ref addr preserved")

# ── extract-refs: :range-ref for LAMBDA body ranges ──────────────

(assert (deep= @[[:range-ref "$A$4" "$ZY"] [:range-ref "$1" "$1"]]
               (formula-deps/extract-refs
                 [:call "LAMBDA"
                        [[:name "key"]
                         [:call "INDEX"
                                [[:range "$A$4" "$ZY"]
                                 [:empty]
                                 [:call "MATCH"
                                        [[:name "key"]
                                         [:range "$1" "$1"]
                                         [:num 0]]]]]]]))
        "LAMBDA body ranges collected as :range-ref (deduped)")

# ── extract-refs: :range-ref for lookup-function range args ───────

(assert (deep= @[[:range-ref "$A$4" "$ZY"] [:range-ref "$1" "$1"]]
               (formula-deps/extract-refs
                 [:call "INDEX"
                        [[:range "$A$4" "$ZY"]
                         [:empty]
                         [:call "MATCH"
                                [[:name "key"]
                                 [:range "$1" "$1"]
                                 [:num 0]]]]]))
        "INDEX range args → :range-ref; nested MATCH range → :range-ref")

# Non-range args of lookup functions are still walked.
(assert (deep= @[[:ref "A1"] [:range-ref "B1" "B10"]]
               (formula-deps/extract-refs
                 [:call "VLOOKUP" [[:ref "A1"] [:range "B1" "B10"] [:num 2]]]))
        "VLOOKUP: key ref A1 walked; lookup range → :range-ref")

# ── trace: lookup range shown as :range-ref leaf ─────────────────

(def merged-index
  @[(range- @[
      @[(cell "A4" "vA" "=LET(x;1;{x\\x})") (cell "B4" "vB" "")]
      @[(cell "Z10" "r" "=INDEX($A$4:$F$100;; MATCH(\"key\";$A$1:$F$1;0))")]])])

(def t-idx (formula-deps/trace merged-index "Z10"))
(assert (= :formula (get t-idx :kind)) "INDEX formula: kind :formula")
# $A$4:$F$100 and $A$1:$F$1 become :range-ref leaves (same-sheet lookup tables).
(def idx-kids (get t-idx :children))
(assert (= 2 (length idx-kids)) "two :range-ref children for the two ranges")
(each k idx-kids (assert (= :range-ref (get k :kind)) "each child is :range-ref"))

# ── trace: analysis-row populates :cells on same-sheet :range-ref ───
#
# When the caller supplies the row of interest, trace should surface
# the cells of that row inside same-sheet lookup ranges as leaf
# children on the range-ref node (no deep recursion).

(def t-idx-row (formula-deps/trace merged-index "Z10" @{} 4))
(def idx-kids-row (get t-idx-row :children))
(assert (= 2 (length idx-kids-row)) "still two range-ref children with analysis-row")
(def first-rr (first idx-kids-row))
(assert (= :range-ref (get first-rr :kind)) "first child stays :range-ref")
(def rr-cells (get first-rr :cells @[]))
(assert (array? rr-cells) "cells field is an array on range-ref")
# $A$4:$F$100 covers A4/B4 on row 4 (A4 is the formula home for both).
# A4 is the :formula home; visited already contains Z10's src (Z10),
# so A4 is attached as a :formula leaf with no expanded children.
(assert (pos? (length rr-cells)) "row cells surfaced for same-sheet range")
(def a4-node
  (do (var found nil)
      (each n rr-cells (when (= "A4" (get n :addr)) (set found n)))
      found))
(assert (not (nil? a4-node)) "A4 is among the row-cells")
(assert (= :formula (get a4-node :kind)) "A4 leaf reports :formula kind")
(assert (= "A4" (get a4-node :src)) "A4 formula home preserved")

# $A$1:$F$1 has no cells on row 4 → :cells absent.
(def second-rr (get idx-kids-row 1))
(assert (= :range-ref (get second-rr :kind)) "second child stays :range-ref")
(assert (empty? (get second-rr :cells @[]))
        "no cells on row 4 inside $A$1:$F$1")

# ── trace: LAMBDA body ranges shown as :range-ref leaves ─────────

(def merged-lambda
  @[(range- @[
      @[(cell "A1" 10 "")]
      @[(cell "B1" 5 "=LET(f; LAMBDA(x; INDEX($A$1:$A$100;;x)); f(1))")]])])

(def t-lam (formula-deps/trace merged-lambda "B1"))
(assert (= :formula (get t-lam :kind)) "LAMBDA formula: kind :formula")
# $A$1:$A$100 from inside the LAMBDA body → :range-ref leaf.
(def lam-kids (get t-lam :children))
(assert (= 1 (length lam-kids)) "one :range-ref child from LAMBDA body range")
(assert (= :range-ref (get (first lam-kids) :kind)) "LAMBDA body range is :range-ref")
(assert (= "$A$1:$A$100" (get (first lam-kids) :addr)) "range addr preserved")

# ── trace: cross-sheet range marked :external ─────────────────────
#
# Ranges with a sheet prefix (ce!$A3:$BH, 'Тарифы'!$1:$1) belong to
# another sheet that is not in `merged`.  Instead of expanding them
# (which would scan the current sheet's cells with the wrong bounds),
# trace emits a single :external child for the whole range.

(def merged-xsheet
  @[(range- @[
      @[(cell "A1" 1 "=SUM(OtherSheet!A1:A3)")]])])

(def t-xs (formula-deps/trace merged-xsheet "A1"))
(assert (= :formula (get t-xs :kind)) "cross-sheet formula")
(def xs-kids (get t-xs :children))
(assert (= 1 (length xs-kids)) "one external child for cross-sheet range")
(assert (= :external (get (first xs-kids) :kind)) "child is :external")
(assert (string/find "OtherSheet!" (get (first xs-kids) :addr)) "addr preserves sheet prefix")

(print "formula-deps_test: all assertions passed")
