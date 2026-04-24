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

# ── BY_NM_IDS ───────────────────────────────────────────────────
# Named function: BY_NM_IDS(nm_ids; callback)
#   = MAP(nm_ids; LAMBDA(nm_id; IF(nm_id=""; ; callback(nm_id))))
# Blanks pass through as nil; non-blanks are forwarded to callback.
#
# Test uses a cell range context so the test does not depend on
# whether the formula parser treats `;` as a row or column separator
# inside inline array literals (that behaviour changed between releases).

(let [str-cells @[(range- @[
                    @[(cell "A1" "nm1" "") (cell "B1" "" "")]
                    @[(cell "A2" "nm2" "") (cell "B2" "" "")]
                    @[(cell "A3" ""    "") (cell "B3" "" "")]])]
      ctx @{:merged str-cells
            :sheet-name "UNIT"
            :addr "Z1"
            :sheet-cache @{}
            :missing-fns @{}
            :unresolved @[]
            :stub-dir nil}
      # Build the call as an AST so we bypass parser version differences.
      # BY_NM_IDS(A1:A3; LAMBDA(nm_id; nm_id & "-cb"))
      ast [:call "BY_NM_IDS"
                 [[:range "A1" "A3"]
                  [:call "LAMBDA" [[:name "nm_id"]
                                   [:binop "&" [:name "nm_id"] [:str "-cb"]]]]]]
      result (formula-eval/eval ast ctx)]
  (assert (deep= @[@["nm1-cb"] @["nm2-cb"] @[nil]] result)
          "BY_NM_IDS: callback applied to non-blanks, blanks → nil"))

# ── CARDS_COL ───────────────────────────────────────────────────
# Named function: CARDS_COL(key)
#   = CHOOSECOLS(cards!$A$3:$AAB; MATCH(key; cards!$1:$1; 0))
#
# $1:$1  — whole row 1 (no column letters → all columns)
# $A$3:$AAB — rows 3…end, columns A…AAB (no row in second addr → open-ended)
#
# Test pre-populates sheet-cache so no network call is needed.

(let [cards-cells @[(range- @[
                      @[(cell "A1" "id" "")    (cell "B1" "name" "")  (cell "C1" "price" "")]
                      @[(cell "A3" "001" "")   (cell "B3" "red" "")   (cell "C3" "100" "")]
                      @[(cell "A4" "002" "")   (cell "B4" "blue" "")  (cell "C4" "200" "")]])]
      ctx @{:merged merged
            :sheet-name "UNIT"
            :addr "Z1"
            :sheet-cache @{"cards" cards-cells}
            :missing-fns @{}
            :unresolved @[]
            :stub-dir nil}
      result (formula-eval/eval [:call "CARDS_COL" [[:str "name"]]] ctx)]
  (assert (deep= @[@["red"] @["blue"]] result)
          "CARDS_COL: returns named column from cards sheet"))

# ── CONFIG ──────────────────────────────────────────────────────
# Named function: CONFIG(arg_name)
#   = XLOOKUP(arg_name; config!$A$4:$A; config!$B$4:$B; ; 0)
#
# config!$A$4:$A and config!$B$4:$B are open-ended column ranges
# (no row number in second addr → rows 4…max-row via resolve-range fix).

(let [config-cells @[(range- @[
                       @[(cell "A4" "host" "") (cell "B4" "example.com" "")]
                       @[(cell "A5" "port" "") (cell "B5" "8080" "")]])]
      ctx @{:merged merged
            :sheet-name "UNIT"
            :addr "Z1"
            :sheet-cache @{"config" config-cells}
            :missing-fns @{}
            :unresolved @[]
            :stub-dir nil}]
  (assert (= "example.com" (formula-eval/eval [:call "CONFIG" [[:str "host"]]] ctx))
          "CONFIG: returns value for matching key")
  (assert (= "8080" (formula-eval/eval [:call "CONFIG" [[:str "port"]]] ctx))
          "CONFIG: second row lookup"))

# ── GET_BASKET ──────────────────────────────────────────────────
# Named function: GET_BASKET(s_id)
#   = IFS(s_id<=143;"01"; s_id<=287;"02"; … s_id>2406;"16")
# Pure computation — no sheet refs; fresh-ctx is sufficient.

(let [gb (fn [n] (formula-eval/eval [:call "GET_BASKET" [[:num n]]] (fresh-ctx)))]
  (assert (= "01" (gb 1))    "GET_BASKET: 1 → 01")
  (assert (= "01" (gb 143))  "GET_BASKET: 143 → 01 (boundary)")
  (assert (= "02" (gb 144))  "GET_BASKET: 144 → 02")
  (assert (= "05" (gb 1000)) "GET_BASKET: 1000 → 05")
  (assert (= "15" (gb 2405)) "GET_BASKET: 2405 → 15 (boundary)")
  (assert (= "16" (gb 2500)) "GET_BASKET: 2500 → 16"))

# ── IFBLANK ─────────────────────────────────────────────────────
# Named function: IFBLANK(value; value_if_blank)
#   = IF(value=""; value_if_blank; value)

(let [ib (fn [v fb] (formula-eval/eval
                      [:call "IFBLANK" [[:str v] [:str fb]]]
                      (fresh-ctx)))]
  (assert (= "fallback" (ib "" "fallback")) "IFBLANK: blank → value_if_blank")
  (assert (= "hello"    (ib "hello" "fallback")) "IFBLANK: non-blank → value")
  (assert (= "fallback" (formula-eval/eval
                          [:call "IFBLANK" [[:empty] [:str "fallback"]]]
                          (fresh-ctx)))
          "IFBLANK: nil/empty → value_if_blank"))

# ── UNIT_COL ────────────────────────────────────────────────────
# Named function: UNIT_COL(key)
#   = CHOOSECOLS(UNIT!$A$6:$AAM; MATCH(key; UNIT!$1:$1; 0))
#
# UNIT! refers to the primary sheet — data goes into ctx :merged directly.
# Header in row 1; data starts at row 6.

(let [unit-cells @[(range- @[
                     @[(cell "A1" "id" "")  (cell "B1" "name" "") (cell "C1" "price" "")]
                     @[(cell "A6" "001" "") (cell "B6" "red" "")  (cell "C6" "100" "")]
                     @[(cell "A7" "002" "") (cell "B7" "blue" "") (cell "C7" "200" "")]])]
      ctx @{:merged unit-cells
            :sheet-name "UNIT"
            :addr "Z1"
            :sheet-cache @{}
            :missing-fns @{}
            :unresolved @[]
            :stub-dir nil}
      result (formula-eval/eval [:call "UNIT_COL" [[:str "name"]]] ctx)]
  (assert (deep= @[@["red"] @["blue"]] result)
          "UNIT_COL: returns named column from UNIT sheet"))

(print "formula-eval_test: all assertions passed")
