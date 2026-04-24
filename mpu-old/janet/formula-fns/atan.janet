(formula-eval/register "ATAN"
  (fn [args ctx] (math/atan (formula-eval/eval (get args 0) ctx))))
