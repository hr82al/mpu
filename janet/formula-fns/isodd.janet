# ISODD(value)
(formula-eval/register "ISODD"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (unless (number? v) (errorf "ISODD: expected number, got %j" v))
    (not (zero? (mod (math/trunc v) 2)))))
