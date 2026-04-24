(formula-eval/register "COUNTIF"
  (fn [args ctx]
    (def range (formula-eval/eval (get args 0) ctx))
    (def crit (formula-eval/parse-criterion
                (formula-eval/eval (get args 1) ctx)))
    (var n 0)
    (defn walk [v]
      (cond
        (indexed? v) (each e v (walk e))
        (when (formula-eval/matches-criterion v crit) (++ n))))
    (walk range)
    n))
