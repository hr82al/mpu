(formula-eval/register "TAN"
  (fn [args ctx] (math/tan (formula-eval/eval (get args 0) ctx))))
