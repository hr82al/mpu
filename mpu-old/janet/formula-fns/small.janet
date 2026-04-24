(formula-eval/register "SMALL"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers [(get args 0)] ctx))
    (def k (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def sorted (sort nums))
    (get sorted (- k 1))))
