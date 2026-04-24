# UNIT_COL(key) — named-function wrapper defined in the sheet.
#
# Body:
#   =CHOOSECOLS(UNIT!$A$6:$AAM; MATCH(key; UNIT!$1:$1; 0))
#
# Returns the entire column from the UNIT data range (rows 6…end) whose
# header cell (row 1) equals key.

(def- unit-col/*body-ast*
  (formula-parser/parse
    ``=CHOOSECOLS(UNIT!$A$6:$AAM;MATCH(key;UNIT!$1:$1;0))``))

(formula-eval/register "UNIT_COL"
  (fn [args ctx]
    (when (< (length args) 1)
      (error "UNIT_COL: expected (key)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "key"] (get args 0)
              unit-col/*body-ast*]]
      ctx)))
