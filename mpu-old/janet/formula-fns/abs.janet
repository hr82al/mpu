(formula-eval/register "ABS"
  (fn [args ctx] (math/abs (formula-eval/eval (get args 0) ctx))))
