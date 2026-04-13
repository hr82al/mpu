# Pure-logic tests for formula-eval (AST walker + function dispatch).
#   mpu repl janet/tests/formula-eval_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

(def- merged
  @[(range- @[
      @[(cell "A1" 10 "") (cell "B1" 20 "")]
      @[(cell "A2" 3  "") (cell "B2" 4  "")]])])

(defn- fresh-ctx []
  @{:merged merged
    :sheet-name "UNIT"
    :addr "Z1"
    :sheet-cache @{}
    :missing-fns @{}
    :unresolved @[]
    :stub-dir nil})        # nil disables auto-file generation in tests

# ── literals ─────────────────────────────────────────────────────

(assert (= 42      (formula-eval/eval [:num 42]    (fresh-ctx))) ":num")
(assert (= "hi"    (formula-eval/eval [:str "hi"]  (fresh-ctx))) ":str")
(assert (= true    (formula-eval/eval [:bool true] (fresh-ctx))) ":bool")
(assert (nil?      (formula-eval/eval [:empty]     (fresh-ctx))) ":empty")

# ── refs & ranges ────────────────────────────────────────────────

(assert (= 10 (formula-eval/eval [:ref "A1"] (fresh-ctx))) "ref A1 = 10")
(assert (= 20 (formula-eval/eval [:ref "$B$1"] (fresh-ctx)))
        "ref $B$1 strips $ for lookup")
(assert (deep= @[@[10 20] @[3 4]]
               (formula-eval/eval [:range "A1" "B2"] (fresh-ctx)))
        "range returns 2D row-major")

# ── operators ────────────────────────────────────────────────────

(assert (= 3  (formula-eval/eval [:binop "+" [:num 1] [:num 2]] (fresh-ctx))) "1+2")
(assert (= 12 (formula-eval/eval [:binop "*" [:num 3] [:num 4]] (fresh-ctx))) "3*4")
(assert (= 8  (formula-eval/eval [:binop "^" [:num 2] [:num 3]] (fresh-ctx))) "2^3")
(assert (= -5 (formula-eval/eval [:unop "-" [:num 5]] (fresh-ctx))) "unary -")
(assert (= 0.5 (formula-eval/eval [:postfix "%" [:num 50]] (fresh-ctx))) "50% → 0.5")
(assert (= "ab" (formula-eval/eval [:binop "&" [:str "a"] [:str "b"]] (fresh-ctx))) "&")
(assert (= true (formula-eval/eval [:binop ">" [:num 2] [:num 1]] (fresh-ctx))) "2>1")
(assert (= true (formula-eval/eval [:binop "=" [:num 2] [:num 2]] (fresh-ctx))) "2=2")
(assert (= true (formula-eval/eval [:binop "<>" [:num 2] [:num 3]] (fresh-ctx))) "<>")

# ── call dispatch ────────────────────────────────────────────────

# Register a synthetic fn for the test (open/closed extension point).
(formula-eval/register "DOUBLE"
  (fn [args ctx]
    (* 2 (formula-eval/eval (get args 0) ctx))))

(assert (= 84 (formula-eval/eval [:call "DOUBLE" [[:num 42]]] (fresh-ctx)))
        "registered call DOUBLE(42) = 84")

# ── stub: missing function records and returns :stub ────────────

(def ctx1 (fresh-ctx))
(def result (formula-eval/eval [:call "UNKNOWN_FN" [[:num 1]]] ctx1))
(assert (deep= [:stub "UNKNOWN_FN"] result)
        "missing fn returns [:stub name]")
(assert (get (ctx1 :missing-fns) "UNKNOWN_FN")
        "missing fn recorded in ctx")

# Case-insensitive lookup.
(assert (= 84 (formula-eval/eval [:call "double" [[:num 42]]] (fresh-ctx)))
        "lowercase dispatch works")

# ── LET / LAMBDA scoping ────────────────────────────────────────
# LET(x, 3, x+1) → 4
(assert (= 4 (formula-eval/eval
               (formula-parser/parse "=LET(x,3,x+1)")
               (fresh-ctx)))
        "LET simple bind")

# LET chain: later names see earlier
(assert (= 7 (formula-eval/eval
               (formula-parser/parse "=LET(a,3,b,a+4,b)")
               (fresh-ctx)))
        "LET chained bindings")

# LAMBDA bound in LET, called by name
(assert (= 10 (formula-eval/eval
                (formula-parser/parse "=LET(double,LAMBDA(x,x*2),double(5))")
                (fresh-ctx)))
        "LET + LAMBDA + call-by-name")

(print "formula-eval_test: all assertions passed")
