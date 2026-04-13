# FLOOR(value, [factor]) — round down to nearest multiple of factor.
(formula-eval/register "FLOOR"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def f (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 1))
    (* f (math/floor (/ v f)))))
