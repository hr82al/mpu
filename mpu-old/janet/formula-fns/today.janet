# TODAY() — current date as Sheets serial (no time component).
(formula-eval/register "TODAY"
  (fn [args ctx]
    (+ formula-eval/*sheets-epoch-offset*
       (math/floor (/ (os/time) 86400)))))
