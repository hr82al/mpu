(formula-eval/register "DAYS"
  (fn [args ctx]
    (- (formula-eval/eval (get args 0) ctx)
       (formula-eval/eval (get args 1) ctx))))
