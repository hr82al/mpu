# UNICODE — decimal code of first code-point (ASCII only here).
(formula-eval/register "UNICODE"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (if (empty? s) (error "UNICODE: empty") (get s 0))))
