(formula-eval/register "TRANSPOSE"
  (fn [args ctx]
    (def v (formula-eval/as-2d (formula-eval/eval (get args 0) ctx)))
    (def rows (length v))
    (def cols (length (get v 0)))
    (def out @[])
    (for c 0 cols
      (def row @[])
      (for r 0 rows (array/push row (get (get v r) c)))
      (array/push out row))
    out))
