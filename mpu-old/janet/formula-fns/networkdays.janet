# NETWORKDAYS(start, end, [holidays]) — business days inclusive.
# Mon-Fri only; ignores holidays for this minimal impl.
(formula-eval/register "NETWORKDAYS"
  (fn [args ctx]
    (def s (math/floor (formula-eval/eval (get args 0) ctx)))
    (def e (math/floor (formula-eval/eval (get args 1) ctx)))
    (def lo (min s e))
    (def hi (max s e))
    (var count 0)
    (for n lo (+ hi 1)
      (def wd ((formula-eval/serial->date n) :week-day))
      # 0=Sunday, 6=Saturday → weekend.
      (when (and (not= wd 0) (not= wd 6)) (++ count)))
    count))
