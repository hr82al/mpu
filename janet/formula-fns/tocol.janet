(formula-eval/register "TOCOL"
  (fn [args ctx]
    (formula-eval/flatten-any (formula-eval/eval (get args 0) ctx))))
