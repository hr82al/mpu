(formula-eval/register "BIN2DEC"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (var v 0)
    (each c s
      (when (or (= c (chr "0")) (= c (chr "1")))
        (set v (+ (* 2 v) (- c (chr "0"))))))
    v))
