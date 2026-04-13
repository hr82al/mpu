# SORTN(range, [n], [display_ties_mode], [sort_column], [is_ascending])
# Minimal: return first `n` after ascending sort.
(formula-eval/register "SORTN"
  (fn [args ctx]
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 0) ctx)))
    (def n (if (>= (length args) 2)
             (math/trunc (formula-eval/eval (get args 1) ctx)) 1))
    (array/slice (sort (array ;data)) 0 n)))
