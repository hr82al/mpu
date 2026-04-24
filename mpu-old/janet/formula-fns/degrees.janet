(formula-eval/register "DEGREES"
  (fn [args ctx] (/ (* (formula-eval/eval (get args 0) ctx) 180) math/pi)))
