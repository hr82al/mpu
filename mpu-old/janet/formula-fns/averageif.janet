(formula-eval/register "AVERAGEIF"
  (fn [args ctx]
    (def range (formula-eval/eval (get args 0) ctx))
    (def crit (formula-eval/parse-criterion
                (formula-eval/eval (get args 1) ctx)))
    (var sum 0) (var n 0)
    (defn walk [v]
      (cond
        (indexed? v) (each e v (walk e))
        (when (and (number? v) (formula-eval/matches-criterion v crit))
          (+= sum v) (++ n))))
    (walk range)
    (if (zero? n) (error "AVERAGEIF: no matches") (/ sum n))))
