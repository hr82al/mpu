# WRAPROWS(vector, wrap_count, [pad]) — reshape into wrap_count-sized rows.
(formula-eval/register "WRAPROWS"
  (fn [args ctx]
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 0) ctx)))
    (def w (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def out @[])
    (var i 0)
    (while (< i (length data))
      (array/push out (array/slice data i (min (+ i w) (length data))))
      (+= i w))
    out))
