# IF(condition, then, else?) — classic three-arg conditional.

(formula-eval/register "IF"
  (fn [args ctx]
    (def c (formula-eval/eval (get args 0) ctx))
    (def truthy (and c (not= c false) (not= c 0) (not= c "")))
    (if truthy
      (formula-eval/eval (get args 1) ctx)
      (if (> (length args) 2)
        (formula-eval/eval (get args 2) ctx)
        false))))
