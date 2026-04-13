# VSTACK(array1, array2, …) — stack vertically.
(formula-eval/register "VSTACK"
  (fn [args ctx]
    (def out @[])
    (each a args
      (def v (formula-eval/as-2d (formula-eval/eval a ctx)))
      (each row v (array/push out row)))
    out))
