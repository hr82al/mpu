# Tests for MAP(array1, [array2, …], lambda).
# Ref: https://support.google.com/docs/answer/12568985
#   mpu repl janet/tests/map_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

(def- merged
  @[(range- @[
      @[(cell "A1" 1 "") (cell "B1" 10 "")]
      @[(cell "A2" 2 "") (cell "B2" 20 "")]
      @[(cell "A3" 3 "") (cell "B3" 30 "")]])])

(defn- ctx []
  @{:merged merged :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- run [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ── single-array: apply lambda to each row (2D in, 2D out) ──────
(assert (deep= @[@[2] @[4] @[6]]
               (run "=MAP(A1:A3, LAMBDA(x, x*2))"))
        "MAP with single 1-col array")

# ── two parallel arrays → lambda gets both ──────────────────────
(assert (deep= @[@[11] @[22] @[33]]
               (run "=MAP(A1:A3, B1:B3, LAMBDA(a, b, a+b))"))
        "MAP over two arrays in lockstep")

# ── 2D array, 2D result ─────────────────────────────────────────
(assert (deep= @[@[2 20] @[4 40] @[6 60]]
               (run "=MAP(A1:B3, LAMBDA(x, x*2))"))
        "MAP over 2D block preserves shape")

# ── arity ────────────────────────────────────────────────────────
(def err (protect (run "=MAP()")))
(assert (not (get err 0)) "zero args errors")

(def err2 (protect (run "=MAP(A1:A3)")))
(assert (not (get err2 0)) "missing lambda errors")

(print "map_test: all assertions passed")
