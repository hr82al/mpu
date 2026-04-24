# formula-eval.janet — walk a formula-parser AST and compute a value.
#
# Loaded at VM boot via loadJanetScripts.
#
# Context (ctx) is a table with:
#   :merged           — decoded batch-get-all output for the primary sheet
#   :sheet-name       — primary sheet's name
#   :addr             — target cell (for diagnostics)
#   :spreadsheet-id   — (optional) for cross-sheet loads
#   :sheet-cache      — @{sheet-name → merged} — populated lazily
#   :missing-fns      — @{NAME true} — set of unresolved :call names
#   :unresolved       — @[…]  — list of unresolvable nodes ([:name "X"], etc.)
#   :stub-dir         — filesystem path to write fn stub files (nil disables)
#
# SOLID layout:
#   * Evaluator (single responsibility) walks the AST.
#   * Function registry (*fns*) is the extension point — adding a call
#     handler is a one-line (register NAME fn).
#   * Stub fallback records diagnostics and optionally writes a template.

(var formula-eval/eval nil)   # forward declaration — defined at EOF

(def formula-eval/*fns*
  "NAME (uppercase) → (fn [raw-args ctx] …). Handlers receive RAW ast
   args so they can short-circuit (IF) or defer evaluation (LAMBDA)."
  @{})

(defn formula-eval/register [name handler]
  (put formula-eval/*fns* (string/ascii-upper name) handler))

# Sentinel for nil/blank stored in env tables (LET bindings and lambda params).
# Janet's (put tbl key nil) removes the key, so we cannot store nil
# directly. This keyword stands for "this binding is nil/blank".
# :name eval unwraps it back to nil. Public so let.janet can reference it.
(def formula-eval/*nil-cell* :formula-nil-cell)

# ── cell / range helpers ─────────────────────────────────────────

(defn- strip-dollars [s]
  (def b @"")
  (each c s
    (unless (= c (chr "$")) (buffer/push-byte b c)))
  (string b))

(defn- split-sheet-ref [text]
  # "Sheet!A1" → ["Sheet" "A1"]; "A1" → [nil "A1"]. Quoted names supported.
  (def bang (string/find "!" text))
  (if bang
    (let [sh (string/slice text 0 bang)
          addr (string/slice text (+ bang 1))
          sh2 (if (and (> (length sh) 1)
                       (= (get sh 0) (chr "'"))
                       (= (get sh (- (length sh) 1)) (chr "'")))
                (string/slice sh 1 (- (length sh) 1))
                sh)]
      [sh2 addr])
    [nil text]))

(defn- cell-value [cell]
  (def v (and cell (get cell "v")))
  (if (or (nil? v) (and (string? v) (empty? v))) nil v))

(defn formula-eval/load-sheet
  "Load a whole sheet via mpu/batch-get-all and cache in ctx. Idempotent."
  [ctx name]
  (def cache (ctx :sheet-cache))
  (if-let [hit (get cache name)]
    hit
    (let [ssid (ctx :spreadsheet-id)]
      (unless ssid (errorf "load-sheet %s needs :spreadsheet-id in ctx" name))
      (def raw (mpu/batch-get-all :spreadsheet-id ssid :sheet-name name))
      (def merged (json/decode raw))
      (put cache name merged)
      merged)))

(defn- merged-for [ctx sheet]
  (if (or (nil? sheet) (= sheet (ctx :sheet-name)))
    (ctx :merged)
    (formula-eval/load-sheet ctx sheet)))

(defn- resolve-ref [ref-text ctx]
  (def [sheet raw-addr] (split-sheet-ref ref-text))
  (def addr (strip-dollars raw-addr))
  (def merged (merged-for ctx sheet))
  (cell-value (formula-finder/lookup-cell merged addr)))

# ── range expansion ──────────────────────────────────────────────

(defn- col-index [letters]
  (def A (chr "A"))
  (var col 0)
  (each c letters (set col (+ (* col 26) (- c A) 1)))
  col)

(defn- split-addr [addr]
  # "AA100" → ["AA" 100]. Allows open forms ("A" → ["A" nil], "10" → [nil 10]).
  (def n (length addr))
  (var i 0)
  (def A (chr "A"))
  (def Z (chr "Z"))
  (while (and (< i n) (>= (get addr i) A) (<= (get addr i) Z)) (++ i))
  (def letters (if (pos? i) (string/slice addr 0 i)))
  (def digits  (if (< i n) (scan-number (string/slice addr i))))
  [letters digits])

(defn- addr-str [col row]
  # 1-based col → letters; append row.
  (def b @"")
  (var c col)
  (while (pos? c)
    (def rem (mod (- c 1) 26))
    (buffer/push-byte b (+ (chr "A") rem))
    (set c (div (- c 1) 26)))
  (string (string/reverse (string b)) row))

# Compute max occupied row/col by scanning cell addresses in merged data.
(defn- sheet-max-row [merged]
  (var mx 0)
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (when (get cell "a")
          (def [r _] (formula-finder/cell->rc (get cell "a")))
          (when (> r mx) (set mx r))))))
  mx)

(defn- sheet-max-col [merged]
  (var mx 0)
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (when (get cell "a")
          (def [_ c] (formula-finder/cell->rc (get cell "a")))
          (when (> c mx) (set mx c))))))
  mx)

(defn- resolve-range [a1 a2 ctx]
  (def [sheet1 raw1] (split-sheet-ref a1))
  (def addr1 (strip-dollars raw1))
  (def addr2 (strip-dollars a2))
  (def [l1 r1] (split-addr addr1))
  (def [l2 r2] (split-addr addr2))
  (def merged (merged-for ctx sheet1))
  # Column bounds:
  #   • $1:$1 style (no letters in either addr) → whole row: 1…max-col
  #   • normal: explicit col-index, defaulting to c1 when l2 absent
  (def c1 (if l1 (col-index l1) 1))
  (def c2 (cond
    (and (nil? l1) (nil? l2)) (sheet-max-col merged)   # whole-row ref
    l2                        (col-index l2)
    c1))
  # Row bounds:
  #   • r2 absent (e.g. $A$3:$AAB — column with no row) → open-ended: rr1…max-row
  (def rr1 (or r1 1))
  (def rr2 (if (nil? r2) (sheet-max-row merged) r2))
  (def out @[])
  (for r (min rr1 rr2) (+ (max rr1 rr2) 1)
    (def row @[])
    (for c (min c1 c2) (+ (max c1 c2) 1)
      (array/push row (cell-value (formula-finder/lookup-cell merged (addr-str c r)))))
    (array/push out row))
  out)

# ── operator tables ──────────────────────────────────────────────

(def- *binop-impls*
  @{"+" (fn [a b] (+ (or a 0) (or b 0)))
    "-" (fn [a b] (- (or a 0) (or b 0)))
    "*" (fn [a b] (* (or a 0) (or b 0)))
    "/" (fn [a b] (/ a b))
    "^" (fn [a b] (math/pow a b))
    "&" (fn [a b] (string (or a "") (or b "")))
    # Sheets semantics: blank cell (nil) compares as "" in equality tests.
    "=" (fn [a b] (= (if (nil? a) "" a) (if (nil? b) "" b)))
    "<>" (fn [a b] (not= (if (nil? a) "" a) (if (nil? b) "" b)))
    "<" (fn [a b] (< a b))
    ">" (fn [a b] (> a b))
    "<=" (fn [a b] (<= a b))
    ">=" (fn [a b] (>= a b))})

(def- *unop-impls*
  @{"+" (fn [x] x)
    "-" (fn [x] (- x))})

(def- *postfix-impls*
  @{"%" (fn [x] (* x 0.01))})

# ── stub (file autogen + diagnostic) ─────────────────────────────

(def- stub-template
  `# formula-fns/%s.janet — Sheets function %q.
#
# Receives raw AST args; evaluate with (formula-eval/eval arg ctx).
# Replace the stub body with real behavior. Delete this file to
# regenerate the scaffold on the next auto-run.

(formula-eval/register %q
  (fn [args ctx]
    (def evaluated (map (fn [a] (formula-eval/eval a ctx)) args))
    (printf "# STUB %%s at %%s: %%j" %q (get ctx :addr) evaluated)
    [:stub %q]))
`)

(defn- write-stub-file [dir upper-name]
  (def path (string dir "/" (string/ascii-lower upper-name) ".janet"))
  (unless (os/stat path)
    (os/mkdir dir)
    (spit path (string/format stub-template
                              (string/ascii-lower upper-name)
                              upper-name
                              upper-name
                              upper-name
                              upper-name))))

(defn- with-env [ctx env]
  (def copy (table/clone ctx))
  (put copy :env env)
  copy)

(defn formula-eval/invoke-lambda-with-values
  "Invoke a [:lambda …] with pre-evaluated values (skip eval-time arg walk).
   Use from MAP/REDUCE/FILTER and similar higher-order functions that
   iterate over data values, not ASTs."
  [lam values ctx]
  (def [_ params body captured] lam)
  (def base (or (get captured :env) @{}))
  (def env (table/clone base))
  (for i 0 (min (length params) (length values))
    # (put tbl key nil) removes the key in Janet, so store a sentinel
    # for nil/blank values and unwrap in :name eval.
    (def v (get values i))
    (put env (get params i) (if (nil? v) formula-eval/*nil-cell* v)))
  (formula-eval/eval body (with-env ctx env)))

(defn formula-eval/invoke-lambda [lam args ctx]
  (formula-eval/invoke-lambda-with-values
    lam
    (map (fn [a] (formula-eval/eval a ctx)) args)
    ctx))

(defn formula-eval/stub-call [name args ctx]
  (put (ctx :missing-fns) name true)
  (when (ctx :stub-dir)
    (write-stub-file (ctx :stub-dir) (string/ascii-upper name)))
  [:stub name])

# ── eval ─────────────────────────────────────────────────────────

(set formula-eval/eval (fn formula-eval/eval [ast ctx]
  (def tag (get ast 0))
  (cond
    (= tag :num)   (get ast 1)
    (= tag :str)   (get ast 1)
    (= tag :bool)  (get ast 1)
    (= tag :empty) nil

    (= tag :ref)   (resolve-ref (get ast 1) ctx)
    (= tag :range) (resolve-range (get ast 1) (get ast 2) ctx)

    (= tag :unop)
    (let [op (get ast 1)
          x  (formula-eval/eval (get ast 2) ctx)
          impl (get *unop-impls* op)]
      (unless impl (errorf "unknown unop %s" op))
      (impl x))

    (= tag :postfix)
    (let [op (get ast 1)
          x  (formula-eval/eval (get ast 2) ctx)
          impl (get *postfix-impls* op)]
      (unless impl (errorf "unknown postfix %s" op))
      (impl x))

    (= tag :binop)
    (let [op (get ast 1)
          l  (formula-eval/eval (get ast 2) ctx)
          r  (formula-eval/eval (get ast 3) ctx)
          impl (get *binop-impls* op)]
      (unless impl (errorf "unknown binop %s" op))
      (impl l r))

    (= tag :array)
    (map (fn [e] (formula-eval/eval e ctx)) (get ast 1))

    (= tag :matrix)
    # Preserve 2-D shape: array of rows.
    (map (fn [row]
           (map (fn [e] (formula-eval/eval e ctx)) row))
         (get ast 1))

    (= tag :call)
    (let [name (get ast 1)
          args (get ast 2)
          env (get ctx :env)
          bound (and env (get env name))]
      (cond
        # LET-bound lambda: invoke as a closure.
        (and bound (indexed? bound) (= (get bound 0) :lambda))
        (formula-eval/invoke-lambda bound args ctx)

        # Registered built-in.
        (let [handler (get formula-eval/*fns* (string/ascii-upper name))]
          (if handler
            (handler args ctx)
            (formula-eval/stub-call name args ctx)))))

    (= tag :name)
    (let [n (get ast 1)
          env (get ctx :env)]
      (if (and env (has-key? env n))
        (let [v (get env n)]
          (if (= v formula-eval/*nil-cell*) nil v))
        (do
          (array/push (ctx :unresolved) [:name n (get ctx :addr)])
          [:unresolved n])))

    (errorf "formula-eval: unknown AST tag %v" tag))))
