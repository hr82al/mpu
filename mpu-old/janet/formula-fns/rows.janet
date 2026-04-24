# ROWS(range_or_array) — row count.
(formula-eval/register "ROWS"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (cond
      (and (indexed? v) (indexed? (get v 0))) (length v)   # 2-D
      (indexed? v) (length v)                              # 1-D column
      1)))
