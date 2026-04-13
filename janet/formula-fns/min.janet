# MIN(value1, …) — fold numeric minimum over scalars and ranges.
(formula-eval/register "MIN"
  (fn [args ctx]
    (var best nil)
    (formula-eval/for-each-number
      args ctx
      (fn [n] (when (or (nil? best) (< n best)) (set best n))))
    (or best 0)))
