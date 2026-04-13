# TRUNC(value, [places]) — truncate toward zero.
(formula-eval/register "TRUNC"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def p (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 0))
    (def factor (math/pow 10 p))
    (/ (math/trunc (* v factor)) factor)))
