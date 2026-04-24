# HSTACK(array1, array2, …) — stack horizontally (side by side).
(formula-eval/register "HSTACK"
  (fn [args ctx]
    (def arrays (map (fn [a]
                       (formula-eval/as-2d (formula-eval/eval a ctx)))
                     args))
    (def rows (reduce (fn [a b] (max a (length b))) 0 arrays))
    (def out @[])
    (for r 0 rows
      (def row @[])
      (each arr arrays
        (def src (if (< r (length arr)) (get arr r) @[]))
        (each e src (array/push row e)))
      (array/push out row))
    out))
