(formula-eval/register "STDEV"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers args ctx))
    (when (< (length nums) 2) (error "STDEV: needs ≥2 values"))
    (math/sqrt (/ (formula-eval/sum-sq-dev nums) (- (length nums) 1)))))
