(formula-eval/register "AVERAGE"
  (fn [args ctx]
    (var sum 0) (var n 0)
    (formula-eval/for-each-number args ctx
      (fn [v] (+= sum v) (++ n)))
    (if (zero? n) (error "AVERAGE: no numbers") (/ sum n))))
