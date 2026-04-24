# ODD — round away from zero to next odd integer.
(formula-eval/register "ODD"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def sign (if (neg? v) -1 1))
    (def a (math/abs v))
    (def up (math/ceil a))
    (* sign (if (odd? up) up (+ up 1)))))
