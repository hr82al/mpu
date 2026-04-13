# COUNT — counts numbers (including booleans coerced to 0/1).
(formula-eval/register "COUNT"
  (fn [args ctx]
    (var n 0)
    (defn walk [v]
      (cond
        (number? v)  (++ n)
        (boolean? v) (++ n)
        (indexed? v) (each e v (walk e))))
    (each a args (walk (formula-eval/eval a ctx)))
    n))
