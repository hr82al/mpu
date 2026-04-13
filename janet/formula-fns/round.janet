# ROUND(value, [places]) — half-away-from-zero rounding, as in Sheets.
(formula-eval/register "ROUND"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (def p (if (>= (length args) 2)
             (formula-eval/eval (get args 1) ctx) 0))
    (def factor (math/pow 10 p))
    (def scaled (* v factor))
    (def rounded (if (< scaled 0)
                   (- (math/floor (+ 0.5 (- scaled))))
                   (math/floor (+ 0.5 scaled))))
    (/ rounded factor)))
