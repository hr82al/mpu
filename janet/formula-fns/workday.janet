# WORKDAY(start, days, [holidays]) — shift by N business days.
(formula-eval/register "WORKDAY"
  (fn [args ctx]
    (def s (math/floor (formula-eval/eval (get args 0) ctx)))
    (def n (math/trunc (formula-eval/eval (get args 1) ctx)))
    (var cur s)
    (var left n)
    (def step (if (neg? n) -1 1))
    (while (not (zero? left))
      (+= cur step)
      (def wd ((formula-eval/serial->date cur) :week-day))
      (when (and (not= wd 0) (not= wd 6))
        (-= left step)))
    cur))
