(formula-eval/register "LOWER"
  (fn [args ctx]
    (string/ascii-lower (string (formula-eval/eval (get args 0) ctx)))))
