(formula-eval/register "PRODUCT"
  (fn [args ctx]
    (var p 1)
    (formula-eval/for-each-number args ctx (fn [n] (set p (* p n))))
    p))
