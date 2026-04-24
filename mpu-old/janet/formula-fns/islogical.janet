# ISLOGICAL(value)
(formula-eval/register "ISLOGICAL"
  (fn [args ctx]
    (boolean? (formula-eval/eval (get args 0) ctx))))
