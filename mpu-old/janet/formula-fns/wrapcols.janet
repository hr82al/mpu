# WRAPCOLS(vector, wrap_count, [pad]) — fill column-major.
(formula-eval/register "WRAPCOLS"
  (fn [args ctx]
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 0) ctx)))
    (def w (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def n-cols (math/ceil (/ (length data) w)))
    (def out @[])
    (for r 0 w
      (def row @[])
      (for c 0 n-cols
        (def idx (+ (* c w) r))
        (when (< idx (length data))
          (array/push row (get data idx))))
      (array/push out row))
    out))
