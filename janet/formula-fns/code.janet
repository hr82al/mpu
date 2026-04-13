(formula-eval/register "CODE"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (if (empty? s) (error "CODE: empty string") (get s 0))))
