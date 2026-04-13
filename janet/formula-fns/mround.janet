(formula-eval/register "MROUND"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def m (formula-eval/eval (get args 1) ctx))
    (* m (math/floor (+ (/ v m) 0.5)))))
