# ROUNDUP(value, [places]) — round away from zero.
(formula-eval/register "ROUNDUP"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def p (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 0))
    (def factor (math/pow 10 p))
    (def scaled (* v factor))
    (/ (if (< scaled 0) (math/floor scaled) (math/ceil scaled)) factor)))
