(formula-eval/register "RIGHT"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (def n (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 1))
    (def take (min (length s) (math/trunc n)))
    (string/slice s (- (length s) take))))
