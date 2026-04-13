# PERMUT(n, k) = n! / (n-k)!
(formula-eval/register "PERMUT"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def k (math/trunc (formula-eval/eval (get args 1) ctx)))
    (var p 1)
    (for i 0 k (set p (* p (- n i))))
    p))
