# CARDS_COL(key) — named-function wrapper defined in the sheet.
#
# Body:
#   =CHOOSECOLS(cards!$A$3:$AAB; MATCH(key; cards!$1:$1; 0))
#
# Returns the entire column from the cards data range (rows 3…end) whose
# header cell (row 1) equals key.

(def- cards-col/*body-ast*
  (formula-parser/parse
    ``=CHOOSECOLS(cards!$A$3:$AAB; MATCH(key; cards!$1:$1; 0))``)  )

(formula-eval/register "CARDS_COL"
  (fn [args ctx]
    (when (< (length args) 1)
      (error "CARDS_COL: expected (key)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "key"] (get args 0)
              cards-col/*body-ast*]]
      ctx)))
