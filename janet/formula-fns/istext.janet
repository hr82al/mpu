# ISTEXT(value)
(formula-eval/register "ISTEXT"
  (fn [args ctx]
    (string? (formula-eval/eval (get args 0) ctx))))
