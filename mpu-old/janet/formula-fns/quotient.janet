(formula-eval/register "QUOTIENT"
  (fn [args ctx]
    (math/trunc (/ (formula-eval/eval (get args 0) ctx)
                   (formula-eval/eval (get args 1) ctx)))))
