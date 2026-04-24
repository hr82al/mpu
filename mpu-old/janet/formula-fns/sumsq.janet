(formula-eval/register "SUMSQ"
  (fn [args ctx]
    (var s 0)
    (formula-eval/for-each-number args ctx (fn [v] (+= s (* v v))))
    s))
