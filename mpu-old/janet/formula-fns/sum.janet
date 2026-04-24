# SUM(…) — adds numbers, recursing into ranges/arrays.

(defn- sum-walk [v]
  (cond
    (number? v) v
    (indexed? v)
    (do
      (var t 0)
      (each e v (+= t (sum-walk e)))
      t)
    0))

(formula-eval/register "SUM"
  (fn [args ctx]
    (var t 0)
    (each a args (+= t (sum-walk (formula-eval/eval a ctx))))
    t))
