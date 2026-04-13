(formula-eval/register "LEN"
  (fn [args ctx] (length (string (formula-eval/eval (get args 0) ctx)))))
