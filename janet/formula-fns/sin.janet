(formula-eval/register "SIN"
  (fn [args ctx] (math/sin (formula-eval/eval (get args 0) ctx))))
