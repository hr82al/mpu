# CONFIG(arg_name) — named-function wrapper defined in the sheet.
#
# Body:
#   =XLOOKUP(arg_name; config!$A$4:$A; config!$B$4:$B; ; 0)
#
# Looks up arg_name in column A of the config sheet (rows 4…end)
# and returns the aligned value from column B.
# Returns :na when not found (XLOOKUP default with no missing_value).

(def- config/*body-ast*
  (formula-parser/parse
    ``=XLOOKUP(arg_name;config!$A$4:$A;config!$B$4:$B;;0)``))

(formula-eval/register "CONFIG"
  (fn [args ctx]
    (when (< (length args) 1)
      (error "CONFIG: expected (arg_name)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "arg_name"] (get args 0)
              config/*body-ast*]]
      ctx)))
