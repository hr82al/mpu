# REDUCE(initial, array, LAMBDA(acc, val, …))
(formula-eval/register "REDUCE"
  (fn [args ctx]
    (var acc (formula-eval/eval (get args 0) ctx))
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 1) ctx)))
    (def lam (formula-eval/eval (get args 2) ctx))
    (each v data
      (set acc (formula-eval/invoke-lambda-with-values lam [acc v] ctx)))
    acc))
