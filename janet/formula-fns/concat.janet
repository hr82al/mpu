# CONCAT(value1, value2) — two-arg concat. Use CONCATENATE for many args.
(formula-eval/register "CONCAT"
  (fn [args ctx]
    (string (formula-eval/eval (get args 0) ctx)
            (formula-eval/eval (get args 1) ctx))))
