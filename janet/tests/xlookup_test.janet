# Tests for XLOOKUP(search_key, lookup_range, result_range,
#                    [missing_value], [match_mode], [search_mode]).
# Ref: https://support.google.com/docs/answer/12937038
# Minimal implementation: match_mode=0 (exact), search_mode=1 (first-to-last).
#   mpu repl janet/tests/xlookup_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

# Lookup table: nm_id in A, name in B, price in C.
(def- merged
  @[(range- @[
      @[(cell "A1" 10  "") (cell "B1" "alpha" "") (cell "C1" 100 "")]
      @[(cell "A2" 20  "") (cell "B2" "beta"  "") (cell "C2" 200 "")]
      @[(cell "A3" 30  "") (cell "B3" "gamma" "") (cell "C3" 300 "")]])])

(defn- ctx []
  @{:merged merged :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- run [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ── exact match (1-D lookup, 1-D result) ────────────────────────
(assert (= "beta" (run "=XLOOKUP(20, A1:A3, B1:B3)"))
        "find 20 → beta")
(assert (= 300 (run "=XLOOKUP(30, A1:A3, C1:C3)"))
        "find 30 → 300")

# ── 2-D result range returns a whole row ────────────────────────
(assert (deep= @["beta" 200] (run "=XLOOKUP(20, A1:A3, B1:C3)"))
        "2-col result returns row")

# ── missing: fallback when provided, :na sentinel otherwise ─────
(assert (= "none" (run "=XLOOKUP(99, A1:A3, B1:B3, \"none\")"))
        "missing with fallback → \"none\"")
(assert (= :na   (run "=XLOOKUP(99, A1:A3, B1:B3)"))
        "missing without fallback → :na")

# ── arity errors ────────────────────────────────────────────────
(def err (protect (run "=XLOOKUP(1, A1:A3)")))
(assert (not (get err 0)) "missing result range errors")

(print "xlookup_test: all assertions passed")
