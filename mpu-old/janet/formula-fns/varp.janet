# VARP (population): sum((x-mean)²)/n
(formula-eval/register "VARP"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers args ctx))
    (when (empty? nums) (error "VARP: no values"))
    (/ (formula-eval/sum-sq-dev nums) (length nums))))
