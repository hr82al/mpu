# CEILING(value, [factor]) — round up to nearest multiple of factor.
(formula-eval/register "CEILING"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def f (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 1))
    (* f (math/ceil (/ v f)))))
