# IFNA(value, value_if_na) — return fallback when value is #N/A.
# NA() in this evaluator is represented by the :na keyword.

(formula-eval/register "IFNA"
  (fn [args ctx]
    (when (< (length args) 2)
      (error "IFNA needs (value, value_if_na)"))
    (def v (formula-eval/eval (get args 0) ctx))
    (if (= v :na)
      (formula-eval/eval (get args 1) ctx)
      v)))
