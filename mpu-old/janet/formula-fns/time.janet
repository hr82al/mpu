(formula-eval/register "TIME"
  (fn [args ctx]
    (formula-eval/hms->fraction
      (formula-eval/eval (get args 0) ctx)
      (formula-eval/eval (get args 1) ctx)
      (formula-eval/eval (get args 2) ctx))))
