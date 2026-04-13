# ARABIC(roman) — convert Roman numeral string to integer.
(def- roman-map
  {(chr "I") 1 (chr "V") 5 (chr "X") 10 (chr "L") 50
   (chr "C") 100 (chr "D") 500 (chr "M") 1000})

(formula-eval/register "ARABIC"
  (fn [args ctx]
    (def s (string/ascii-upper
             (string (formula-eval/eval (get args 0) ctx))))
    (def n (length s))
    (var total 0)
    (for i 0 n
      (def v (get roman-map (get s i)))
      (def next-v (if (< (+ i 1) n) (get roman-map (get s (+ i 1))) 0))
      (if (and v next-v (< v next-v))
        (-= total v)
        (+= total (or v 0))))
    total))
