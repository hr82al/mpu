# WEEKDAY(date, [type]) — type 1 default: Sun=1 … Sat=7.
(formula-eval/register "WEEKDAY"
  (fn [args ctx]
    (def d (formula-eval/serial->date (formula-eval/eval (get args 0) ctx)))
    (+ 1 (d :week-day))))
