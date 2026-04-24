# FILTER(range, condition1, [condition2, …]) — keep rows where all
# conditions are truthy. Minimal: treats conditions as boolean arrays.
(formula-eval/register "FILTER"
  (fn [args ctx]
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 0) ctx)))
    (def masks
      (map (fn [i] (formula-eval/flatten-any
                     (formula-eval/eval (get args i) ctx)))
           (range 1 (length args))))
    (def out @[])
    (for i 0 (length data)
      (var keep true)
      (each mk masks
        (unless (formula-eval/truthy? (get mk i)) (set keep false)))
      (when keep (array/push out (get data i))))
    out))
