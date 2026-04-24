(formula-eval/register "SUMIF"
  (fn [args ctx]
    (def range (formula-eval/eval (get args 0) ctx))
    (def crit (formula-eval/parse-criterion
                (formula-eval/eval (get args 1) ctx)))
    (var total 0)
    (defn walk [v]
      (cond
        (indexed? v) (each e v (walk e))
        (when (and (number? v) (formula-eval/matches-criterion v crit))
          (+= total v))))
    (walk range)
    total))
