# FLATTEN(…) — row-major flattening of one or more arrays into a 1-D list.
(formula-eval/register "FLATTEN"
  (fn [args ctx]
    (def out @[])
    (each a args
      (def v (formula-eval/eval a ctx))
      (each e (formula-eval/flatten-any v) (array/push out e)))
    out))
