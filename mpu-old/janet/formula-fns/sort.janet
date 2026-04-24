# SORT(array, [sort_column], [is_ascending], …) — minimal: single 1-D
# column, ascending by default.
(formula-eval/register "SORT"
  (fn [args ctx]
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 0) ctx)))
    (def asc (if (>= (length args) 3)
               (formula-eval/truthy?
                 (formula-eval/eval (get args 2) ctx))
               true))
    (def sorted (sort (array ;data)))
    (if asc sorted (reverse sorted))))
