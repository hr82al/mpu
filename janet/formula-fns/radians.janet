(formula-eval/register "RADIANS"
  (fn [args ctx] (/ (* (formula-eval/eval (get args 0) ctx) math/pi) 180)))
