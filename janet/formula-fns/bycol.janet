# BYCOL(array, LAMBDA(col, …)) — apply lambda per column, return 1-row.
(formula-eval/register "BYCOL"
  (fn [args ctx]
    (def v (formula-eval/as-2d (formula-eval/eval (get args 0) ctx)))
    (def lam (formula-eval/eval (get args 1) ctx))
    (def cols (length (get v 0)))
    (def out @[])
    (for c 0 cols
      (def col @[])
      (for r 0 (length v) (array/push col (get (get v r) c)))
      (array/push out
        (formula-eval/invoke-lambda-with-values lam [col] ctx)))
    out))
