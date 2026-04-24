# Shared helper for functions that fold numbers over scalars/ranges/arrays.

(defn formula-eval/for-each-number [args ctx f]
  (defn walk [v]
    (cond
      (number? v) (f v)
      (indexed? v) (each e v (walk e))))
  (each a args (walk (formula-eval/eval a ctx))))
