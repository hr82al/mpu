(formula-eval/register "HOUR"
  (fn [args ctx]
    (def frac (- (formula-eval/eval (get args 0) ctx)
                 (math/floor (formula-eval/eval (get args 0) ctx))))
    (math/floor (* frac 24))))
