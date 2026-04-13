(formula-eval/register "MINUTE"
  (fn [args ctx]
    (def total-secs (math/round (* (- (formula-eval/eval (get args 0) ctx)
                                       (math/floor (formula-eval/eval (get args 0) ctx)))
                                    86400)))
    (mod (math/floor (/ total-secs 60)) 60)))
