# Tests for CL_QUERY — a named wrapper that calls
# KEYSQUERY(checklist!$A$1:$ADT$1; checklist!$A$3:$ADT; query_text; header_rows)
#
#   mpu repl janet/tests/cl_query_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

# Spy: capture raw AST args KEYSQUERY receives. Replaces whatever
# handler was loaded from formula-fns/keysquery.janet.
(var spy-args nil)
(formula-eval/register "KEYSQUERY"
  (fn [args ctx]
    (set spy-args args)
    :spied))

# ── happy path: two args → four-arg KEYSQUERY ───────────────────

(def result
  (formula-eval/eval
    (formula-parser/parse "=CL_QUERY(\"SELECT A WHERE B=1\", 1)")
    (ctx)))

(assert (= :spied result) "CL_QUERY must delegate to KEYSQUERY")
(assert (= 4 (length spy-args))
        "KEYSQUERY must receive exactly 4 args")

(assert (deep= [:range "checklist!$A$1" "$ADT$1"] (get spy-args 0))
        "arg[0] = checklist headers range")
(assert (deep= [:range "checklist!$A$3" "$ADT"] (get spy-args 1))
        "arg[1] = checklist data range")
(assert (deep= [:str "SELECT A WHERE B=1"] (get spy-args 2))
        "arg[2] = caller's query_text")
(assert (deep= [:num 1] (get spy-args 3))
        "arg[3] = caller's header_rows")

# ── arg passthrough: any AST may appear for query/rows ─────────
(set spy-args nil)
(formula-eval/eval
  (formula-parser/parse "=CL_QUERY(query_var, 0)")
  (ctx))
(assert (deep= [:name "query_var"] (get spy-args 2))
        "non-literal query_text passed through as :name AST")
(assert (deep= [:num 0] (get spy-args 3))
        "numeric header_rows passed through")

# ── errors on wrong arity ───────────────────────────────────────

(def r1 (protect (formula-eval/eval
                   (formula-parser/parse "=CL_QUERY(\"q\")")
                   (ctx))))
(assert (not (get r1 0)) "CL_QUERY with 1 arg must error")

(def r0 (protect (formula-eval/eval
                   (formula-parser/parse "=CL_QUERY()")
                   (ctx))))
(assert (not (get r0 0)) "CL_QUERY with 0 args must error")

(print "cl_query_test: all assertions passed")
