# XOR(logical_expression1, …) — true iff an odd number of args are truthy.

(formula-eval/register "XOR"
  (fn [args ctx]
    (var count 0)
    (each a args
      (when (formula-eval/truthy? (formula-eval/eval a ctx))
        (++ count)))
    (odd? count)))
