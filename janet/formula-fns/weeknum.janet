# WEEKNUM(date) — ISO-ish: week with Sunday start (Sheets default type=1).
(formula-eval/register "WEEKNUM"
  (fn [args ctx]
    (def serial (formula-eval/eval (get args 0) ctx))
    (def d (formula-eval/serial->date serial))
    (def jan1 (formula-eval/ymd->serial (d :year) 1 1))
    (def jan1-date (formula-eval/serial->date jan1))
    (def week-start (- jan1 (jan1-date :week-day)))
    (+ 1 (math/floor (/ (- serial week-start) 7)))))
