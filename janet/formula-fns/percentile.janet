# PERCENTILE(data, p) — linear interpolation, p in [0,1].
(formula-eval/register "PERCENTILE"
  (fn [args ctx]
    (def nums (sort (formula-eval/collect-numbers [(get args 0)] ctx)))
    (def p (formula-eval/eval (get args 1) ctx))
    (def n (length nums))
    (def pos (* p (- n 1)))
    (def lo (math/floor pos))
    (def hi (math/ceil pos))
    (if (= lo hi)
      (get nums lo)
      (+ (get nums lo) (* (- pos lo) (- (get nums hi) (get nums lo)))))))
