# LARGE(data, k) — k-th largest.
(formula-eval/register "LARGE"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers [(get args 0)] ctx))
    (def k (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def sorted (reverse (sort nums)))
    (get sorted (- k 1))))
