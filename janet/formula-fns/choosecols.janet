# CHOOSECOLS(array, col1, [col2, …]) — pick columns; negative indexes count
# from the right, per https://support.google.com/docs/answer/13196660 .
(formula-eval/register "CHOOSECOLS"
  (fn [args ctx]
    (def v (formula-eval/as-2d (formula-eval/eval (get args 0) ctx)))
    (def total-cols (length (get v 0)))
    (def out @[])
    (each row v (array/push out @[]))
    (for i 1 (length args)
      (def raw (formula-eval/eval (get args i) ctx))
      (def idx (math/trunc raw))
      (def c (if (< idx 0) (+ total-cols idx 1) idx))
      (when (or (< c 1) (> c total-cols))
        (errorf "CHOOSECOLS: column %d out of range" idx))
      (for r 0 (length v)
        (array/push (get out r) (get (get v r) (- c 1)))))
    out))
