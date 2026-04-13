# POWER(base, exponent)
(formula-eval/register "POWER"
  (fn [args ctx]
    (math/pow (formula-eval/eval (get args 0) ctx)
              (formula-eval/eval (get args 1) ctx))))
