(formula-eval/register "EXP"
  (fn [args ctx] (math/exp (formula-eval/eval (get args 0) ctx))))
