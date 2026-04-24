(formula-eval/register "STDEVP"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers args ctx))
    (when (empty? nums) (error "STDEVP: no values"))
    (math/sqrt (/ (formula-eval/sum-sq-dev nums) (length nums)))))
