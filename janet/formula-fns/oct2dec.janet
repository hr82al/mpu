(formula-eval/register "OCT2DEC"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (var v 0)
    (each c s
      (def d (- c (chr "0")))
      (when (and (>= d 0) (<= d 7))
        (set v (+ (* 8 v) d))))
    v))
