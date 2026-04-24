# COLUMNS(range_or_array) — column count.
(formula-eval/register "COLUMNS"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (cond
      (and (indexed? v) (indexed? (get v 0))) (length (get v 0))  # 2-D
      (indexed? v) (length v)                                      # 1-D row
      1)))
