# VAR (sample): sum((x-mean)²)/(n-1)
(formula-eval/register "VAR"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers args ctx))
    (when (< (length nums) 2) (error "VAR: needs ≥2 values"))
    (/ (formula-eval/sum-sq-dev nums) (- (length nums) 1))))
