# TODAY() — ISO date string (approximation of Sheets serial).

(formula-eval/register "TODAY"
  (fn [args ctx]
    (def d (os/date (os/time) true))
    (string/format "%d-%02d-%02d"
                   (d :year)
                   (+ 1 (d :month))
                   (+ 1 (d :month-day)))))
