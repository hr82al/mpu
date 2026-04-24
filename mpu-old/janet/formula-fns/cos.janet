(formula-eval/register "COS"
  (fn [args ctx] (math/cos (formula-eval/eval (get args 0) ctx))))
