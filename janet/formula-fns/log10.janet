(formula-eval/register "LOG10"
  (fn [args ctx]
    (/ (math/log (formula-eval/eval (get args 0) ctx))
       (math/log 10))))
