(formula-eval/register "UPPER"
  (fn [args ctx]
    (string/ascii-upper (string (formula-eval/eval (get args 0) ctx)))))
