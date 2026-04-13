(formula-eval/register "HEX2DEC"
  (fn [args ctx]
    (def s (string/ascii-upper (string (formula-eval/eval (get args 0) ctx))))
    (var v 0)
    (each c s
      (cond
        (and (>= c (chr "0")) (<= c (chr "9")))
        (set v (+ (* 16 v) (- c (chr "0"))))
        (and (>= c (chr "A")) (<= c (chr "F")))
        (set v (+ (* 16 v) 10 (- c (chr "A"))))))
    v))
