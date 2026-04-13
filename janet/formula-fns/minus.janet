(formula-eval/register "MINUS"
  (fn [args ctx] (- (formula-eval/eval (get args 0) ctx)
                    (formula-eval/eval (get args 1) ctx))))
