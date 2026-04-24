# EOMONTH(start, months) — last day of month, shifted by N months.
(formula-eval/register "EOMONTH"
  (fn [args ctx]
    (def d (formula-eval/serial->date (formula-eval/eval (get args 0) ctx)))
    (def off (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def total (+ (* 12 (d :year)) (d :month) off 1))
    (def y (math/floor (/ total 12)))
    (def m0 (mod total 12))
    (- (formula-eval/ymd->serial y (+ 1 m0) 1) 1)))
