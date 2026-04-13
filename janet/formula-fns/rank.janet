# RANK(value, data, [is_ascending]) — default descending (1 = highest).
(formula-eval/register "RANK"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def nums (formula-eval/collect-numbers [(get args 1)] ctx))
    (def asc (if (>= (length args) 3)
               (formula-eval/eval (get args 2) ctx) false))
    (var rank 1)
    (each x nums
      (when (if asc (< x v) (> x v)) (++ rank)))
    rank))
