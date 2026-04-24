# Sheets ATAN2(x,y) — note: reversed from std atan2(y,x).
(formula-eval/register "ATAN2"
  (fn [args ctx]
    (math/atan2 (formula-eval/eval (get args 1) ctx)
                (formula-eval/eval (get args 0) ctx))))
