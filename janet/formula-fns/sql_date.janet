# SQL_DATE(date) — named wrapper producing a SQL DATE literal.
#
# Body (from the sheet's defined names):
#
#   ="DATE '" & TEXT(date; "yyyy-MM-dd") & "'"

(def- sql-date/*body-ast*
  (formula-parser/parse
    ``="DATE '" & TEXT(date; "yyyy-MM-dd") & "'"``))

(formula-eval/register "SQL_DATE"
  (fn [args ctx]
    (when (< (length args) 1)
      (error "SQL_DATE: expected (date)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "date"] (get args 0)
              sql-date/*body-ast*]]
      ctx)))
