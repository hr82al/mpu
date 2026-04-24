# ARRAYFORMULA(expr) — in Sheets this broadcasts; here we just pass through.

(formula-eval/register "ARRAYFORMULA"
  (fn [args ctx]
    (formula-eval/eval (get args 0) ctx)))
