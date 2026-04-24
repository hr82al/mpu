# BYROW(array, LAMBDA(row, …)) — apply lambda per row, return column.
(formula-eval/register "BYROW"
  (fn [args ctx]
    (def v (formula-eval/as-2d (formula-eval/eval (get args 0) ctx)))
    (def lam (formula-eval/eval (get args 1) ctx))
    (def out @[])
    (each row v
      (array/push out
        (formula-eval/invoke-lambda-with-values lam [row] ctx)))
    out))
