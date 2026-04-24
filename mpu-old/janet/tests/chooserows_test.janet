# Tests for CHOOSEROWS. Runs in an mpu VM with formula-eval and the
# formula-fns loaded; no imports needed.
#
#   mpu repl janet/tests/chooserows_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

# Source data: a 3×2 block A1:B3 = 1..6 in row-major order.
(def- merged
  @[(range- @[
      @[(cell "A1" 1 "") (cell "B1" 2 "")]
      @[(cell "A2" 3 "") (cell "B2" 4 "")]
      @[(cell "A3" 5 "") (cell "B3" 6 "")]])])

(defn- ctx []
  @{:merged merged :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- run [call-ast] (formula-eval/eval call-ast (ctx)))

(def- R [:range "A1" "B3"])

# ── pick a single row ────────────────────────────────────────────
(assert (deep= @[@[1 2]]
               (run [:call "CHOOSEROWS" [R [:num 1]]]))
        "pick row 1")

(assert (deep= @[@[5 6]]
               (run [:call "CHOOSEROWS" [R [:num 3]]]))
        "pick row 3")

# ── multiple rows, arbitrary order ───────────────────────────────
(assert (deep= @[@[5 6] @[1 2]]
               (run [:call "CHOOSEROWS" [R [:num 3] [:num 1]]]))
        "rows 3 then 1")

# ── repeated indices ─────────────────────────────────────────────
(assert (deep= @[@[1 2] @[1 2] @[3 4]]
               (run [:call "CHOOSEROWS" [R [:num 1] [:num 1] [:num 2]]]))
        "rows 1,1,2 (repetition allowed)")

# ── negative index counts from the end ───────────────────────────
(assert (deep= @[@[5 6]]
               (run [:call "CHOOSEROWS" [R [:num -1]]]))
        "-1 → last row")

(assert (deep= @[@[3 4]]
               (run [:call "CHOOSEROWS" [R [:num -2]]]))
        "-2 → second-to-last row")

(assert (deep= @[@[5 6] @[1 2]]
               (run [:call "CHOOSEROWS" [R [:num -1] [:num -3]]]))
        "mix of negative indices")

# ── out-of-range indices must error ──────────────────────────────
(def- r-too-big (protect (run [:call "CHOOSEROWS" [R [:num 99]]])))
(assert (not (get r-too-big 0)) "99 must error (only 3 rows)")

(def- r-zero (protect (run [:call "CHOOSEROWS" [R [:num 0]]])))
(assert (not (get r-zero 0)) "index 0 is invalid (1-based)")

(def- r-neg-too-big (protect (run [:call "CHOOSEROWS" [R [:num -99]]])))
(assert (not (get r-neg-too-big 0)) "-99 must error (only 3 rows)")

# ── missing array / missing indices ──────────────────────────────
(def- r-no-idx (protect (run [:call "CHOOSEROWS" [R]])))
(assert (not (get r-no-idx 0)) "needs at least one index")

(print "chooserows_test: all assertions passed")
