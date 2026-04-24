# ISEVEN(value) — truncates toward zero, tests remainder.
(formula-eval/register "ISEVEN"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (unless (number? v) (errorf "ISEVEN: expected number, got %j" v))
    (zero? (mod (math/trunc v) 2))))
