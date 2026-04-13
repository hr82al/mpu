# Helpers for array-shape normalization.

(defn formula-eval/as-2d [v]
  # Normalize any indexed value to 2-D: list of rows.
  (cond
    (not (indexed? v)) @[@[v]]
    (empty? v) @[@[]]
    (indexed? (get v 0)) v
    @[(if (array? v) v (array ;v))]))   # 1-D row → single-row matrix

(defn formula-eval/flatten-2d [v]
  (def out @[])
  (each row v
    (each e row (array/push out e)))
  out)

(defn formula-eval/flatten-any [v]
  (def out @[])
  (defn walk [x]
    (if (indexed? x) (each e x (walk e)) (array/push out x)))
  (walk v)
  out)
