# ROUNDDOWN(value, [places]) — round toward zero (= TRUNC to places).
(formula-eval/register "ROUNDDOWN"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def p (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 0))
    (def factor (math/pow 10 p))
    (def scaled (* v factor))
    (/ (math/trunc scaled) factor)))
