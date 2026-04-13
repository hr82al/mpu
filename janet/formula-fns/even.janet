# EVEN — round away from zero to next even integer.
(formula-eval/register "EVEN"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def sign (if (neg? v) -1 1))
    (* sign (* 2 (math/ceil (/ (math/abs v) 2))))))
