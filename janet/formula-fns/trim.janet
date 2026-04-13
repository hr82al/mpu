(formula-eval/register "TRIM"
  (fn [args ctx]
    (string/trim (string (formula-eval/eval (get args 0) ctx)))))
