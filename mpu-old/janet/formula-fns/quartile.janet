# QUARTILE(data, q) — q in 0..4 (0=min, 4=max). Reuses PERCENTILE.
(formula-eval/register "QUARTILE"
  (fn [args ctx]
    (def nums (sort (formula-eval/collect-numbers [(get args 0)] ctx)))
    (def q (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def p (/ q 4))
    (def n (length nums))
    (def pos (* p (- n 1)))
    (def lo (math/floor pos))
    (def hi (math/ceil pos))
    (if (= lo hi)
      (get nums lo)
      (+ (get nums lo) (* (- pos lo) (- (get nums hi) (get nums lo)))))))
