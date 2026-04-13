# OR(logical_expression1, …) — true iff any arg is truthy.

(formula-eval/register "OR"
  (fn [args ctx]
    (var result false)
    (each a args
      (when (formula-eval/truthy? (formula-eval/eval a ctx))
        (set result true)))
    result))
