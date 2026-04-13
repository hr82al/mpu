# IFBLANK(value; value_if_blank) — named-function wrapper defined in the sheet.
#
# Body:
#   =IF(value=""; value_if_blank; value)

(def- ifblank/*body-ast*
  (formula-parser/parse
    ``=IF(value="";value_if_blank;value)``))

(formula-eval/register "IFBLANK"
  (fn [args ctx]
    (when (< (length args) 2)
      (error "IFBLANK: expected (value, value_if_blank)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "value"]          (get args 0)
              [:name "value_if_blank"] (get args 1)
              ifblank/*body-ast*]]
      ctx)))
