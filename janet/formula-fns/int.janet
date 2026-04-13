# INT(value) — floor toward -∞ (matches Sheets, unlike TRUNC).
(formula-eval/register "INT"
  (fn [args ctx] (math/floor (formula-eval/eval (get args 0) ctx))))
