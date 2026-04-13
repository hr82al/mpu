# YEARFRAC(start, end, [basis]) — basis 0 = US 30/360 (default).
# Full 30/360 has subtle month-end rules; this minimal form suffices for
# typical date spans.
(formula-eval/register "YEARFRAC"
  (fn [args ctx]
    (def s (formula-eval/eval (get args 0) ctx))
    (def e (formula-eval/eval (get args 1) ctx))
    (def sd (formula-eval/serial->date s))
    (def ed (formula-eval/serial->date e))
    (def y1 (sd :year)) (def m1 (+ 1 (sd :month))) (def d1 (+ 1 (sd :month-day)))
    (def y2 (ed :year)) (def m2 (+ 1 (ed :month))) (def d2 (+ 1 (ed :month-day)))
    (/ (+ (* 360 (- y2 y1)) (* 30 (- m2 m1)) (- d2 d1)) 360)))
