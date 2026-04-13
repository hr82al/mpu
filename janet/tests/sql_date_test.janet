# Tests for SQL_DATE(date) — named wrapper.
#   Body: ="DATE '" & TEXT(date; "yyyy-MM-dd") & "'"
#
#   mpu repl janet/tests/sql_date_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(var text-args nil)
(formula-eval/register "TEXT"
  (fn [args ctx]
    (set text-args
         (map (fn [a] (formula-eval/eval a ctx)) args))
    "FORMATTED"))

# ── happy path: wraps TEXT result in DATE '…' ────────────────────

(def result
  (formula-eval/eval
    (formula-parser/parse "=SQL_DATE(\"2026-04-13\")")
    (ctx)))

(assert (= "DATE 'FORMATTED'" result)
        "SQL_DATE wraps TEXT output in SQL date literal")

(assert (= 2 (length text-args))
        "TEXT receives (date, format)")
(assert (= "2026-04-13" (get text-args 0))
        "arg[0] = caller's date passthrough")
(assert (= "yyyy-MM-dd" (get text-args 1))
        "arg[1] = hardcoded ISO format")

# ── passthrough: numeric date arg (Sheets date serial) ──────────

(set text-args nil)
(formula-eval/eval
  (formula-parser/parse "=SQL_DATE(45678)")
  (ctx))
(assert (= 45678 (get text-args 0))
        "numeric date arg passed through to TEXT")
(assert (= "yyyy-MM-dd" (get text-args 1))
        "format string stays hardcoded")

# ── arity error ──────────────────────────────────────────────────

(def r0 (protect (formula-eval/eval
                   (formula-parser/parse "=SQL_DATE()")
                   (ctx))))
(assert (not (get r0 0)) "SQL_DATE with 0 args must error")

(print "sql_date_test: all assertions passed")
