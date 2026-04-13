# N(value) — coerce to number. Non-numeric strings become 0.
(formula-eval/register "N"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (cond
      (number? v) v
      (= v true) 1
      (= v false) 0
      0)))
