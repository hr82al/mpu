(formula-eval/register "CHAR"
  (fn [args ctx]
    (string/from-bytes (math/trunc (formula-eval/eval (get args 0) ctx)))))
