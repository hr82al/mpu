(formula-eval/register "MEDIAN"
  (fn [args ctx]
    (def nums @[])
    (formula-eval/for-each-number args ctx (fn [v] (array/push nums v)))
    (sort nums)
    (def n (length nums))
    (when (zero? n) (error "MEDIAN: no numbers"))
    (if (odd? n)
      (get nums (div n 2))
      (/ (+ (get nums (- (div n 2) 1)) (get nums (div n 2))) 2))))
