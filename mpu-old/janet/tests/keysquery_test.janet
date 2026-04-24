# Tests for KEYSQUERY(keys, data, querystring, headers).
#
#   mpu repl janet/tests/keysquery_test.janet
#
# KEYSQUERY is a named wrapper whose body eventually calls
# QUERY(data, parsed-query, headers). We spy on QUERY to verify that
# KEYSQUERY forwards `data` and `headers` untouched — the details of
# parsed-query depend on MAP/REDUCE/… which remain stubs here.

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(var query-args nil)
(formula-eval/register "QUERY"
  (fn [args ctx]
    (set query-args
         (map (fn [a] (formula-eval/eval a ctx)) args))
    :spied))

# ── happy path: 4 args arrive, QUERY gets (data, _, headers) ────

(def result
  (formula-eval/eval
    (formula-parser/parse "=KEYSQUERY(\"KEYS\", \"DATA\", \"SELECT *\", 1)")
    (ctx)))

(assert (= :spied result)
        "KEYSQUERY must bottom out in QUERY")
(assert (= 3 (length query-args))
        "QUERY receives (data, parsedquery, headers)")
(assert (= "DATA" (get query-args 0))
        "QUERY arg[0] = caller's data (passthrough)")
(assert (= 1 (get query-args 2))
        "QUERY arg[2] = caller's headers (passthrough)")

# ── wrong arity ─────────────────────────────────────────────────

(def r3 (protect (formula-eval/eval
                   (formula-parser/parse "=KEYSQUERY(\"k\",\"d\",\"q\")")
                   (ctx))))
(assert (not (get r3 0)) "KEYSQUERY with 3 args must error")

(def r0 (protect (formula-eval/eval
                   (formula-parser/parse "=KEYSQUERY()")
                   (ctx))))
(assert (not (get r0 0)) "KEYSQUERY with 0 args must error")

(print "keysquery_test: all assertions passed")
