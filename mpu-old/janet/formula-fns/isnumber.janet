# ISNUMBER(value)
(formula-eval/register "ISNUMBER"
  (fn [args ctx]
    (number? (formula-eval/eval (get args 0) ctx))))
