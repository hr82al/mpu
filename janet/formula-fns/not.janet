# NOT(logical_expression) — invert truthiness.

(formula-eval/register "NOT"
  (fn [args ctx]
    (when (empty? args) (error "NOT needs one argument"))
    (not (formula-eval/truthy? (formula-eval/eval (get args 0) ctx)))))
