(formula-eval/register "LEFT"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (def n (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 1))
    (string/slice s 0 (min (length s) (math/trunc n)))))
