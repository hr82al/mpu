(formula-eval/register "FACT"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (when (neg? n) (error "FACT: negative argument"))
    (var p 1)
    (for i 2 (+ n 1) (set p (* p i)))
    p))
