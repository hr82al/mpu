(formula-eval/register "SQRT"
  (fn [args ctx] (math/sqrt (formula-eval/eval (get args 0) ctx))))
