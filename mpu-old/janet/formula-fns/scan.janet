# SCAN(initial, array, LAMBDA(acc, val, …)) — running reduce, returns all
# intermediate values (same length as array).
(formula-eval/register "SCAN"
  (fn [args ctx]
    (var acc (formula-eval/eval (get args 0) ctx))
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 1) ctx)))
    (def lam (formula-eval/eval (get args 2) ctx))
    (def out @[])
    (each v data
      (set acc (formula-eval/invoke-lambda-with-values lam [acc v] ctx))
      (array/push out acc))
    out))
