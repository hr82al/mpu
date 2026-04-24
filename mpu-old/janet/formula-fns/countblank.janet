(formula-eval/register "COUNTBLANK"
  (fn [args ctx]
    (var n 0)
    (defn walk [v]
      (cond
        (or (nil? v) (and (string? v) (empty? v))) (++ n)
        (indexed? v) (each e v (walk e))))
    (each a args (walk (formula-eval/eval a ctx)))
    n))
