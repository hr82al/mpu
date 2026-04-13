# IFERROR(value, fallback?) — returns fallback on Janet error, else value.

(formula-eval/register "IFERROR"
  (fn [args ctx]
    (def r (protect (formula-eval/eval (get args 0) ctx)))
    (if (get r 0)
      (get r 1)
      (if (> (length args) 1)
        (formula-eval/eval (get args 1) ctx)
        ""))))
