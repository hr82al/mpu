# COMBIN(n, k) = n! / (k!(n-k)!)
(formula-eval/register "COMBIN"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def k (math/trunc (formula-eval/eval (get args 1) ctx)))
    (when (or (neg? n) (neg? k) (> k n)) (error "COMBIN: invalid inputs"))
    (var num 1) (var den 1)
    (for i 0 k
      (set num (* num (- n i)))
      (set den (* den (+ i 1))))
    (/ num den)))
