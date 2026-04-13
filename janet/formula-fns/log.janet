# LOG(value, [base]) — default base is 10.
(formula-eval/register "LOG"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def b (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 10))
    (/ (math/log v) (math/log b))))
