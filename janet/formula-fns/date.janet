(formula-eval/register "DATE"
  (fn [args ctx]
    (formula-eval/ymd->serial
      (formula-eval/eval (get args 0) ctx)
      (formula-eval/eval (get args 1) ctx)
      (formula-eval/eval (get args 2) ctx))))
