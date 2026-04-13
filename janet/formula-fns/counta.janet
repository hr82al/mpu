# COUNTA — counts all non-empty values.
(formula-eval/register "COUNTA"
  (fn [args ctx]
    (var n 0)
    (defn walk [v]
      (cond
        (nil? v) nil
        (and (string? v) (empty? v)) nil
        (indexed? v) (each e v (walk e))
        (++ n)))
    (each a args (walk (formula-eval/eval a ctx)))
    n))
