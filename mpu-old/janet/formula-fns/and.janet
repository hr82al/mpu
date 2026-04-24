# AND(logical_expression1, …) — true iff all args are truthy.

(formula-eval/register "AND"
  (fn [args ctx]
    (var result true)
    (each a args
      (unless (formula-eval/truthy? (formula-eval/eval a ctx))
        (set result false)))
    result))
