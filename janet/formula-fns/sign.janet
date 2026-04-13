# SIGN(value) — -1, 0, or 1.
(formula-eval/register "SIGN"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (cond (pos? v) 1 (neg? v) -1 0)))
