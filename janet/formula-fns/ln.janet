(formula-eval/register "LN"
  (fn [args ctx] (math/log (formula-eval/eval (get args 0) ctx))))
