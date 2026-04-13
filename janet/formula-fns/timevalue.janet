# TIMEVALUE("HH:MM[:SS]") → fractional day.
(formula-eval/register "TIMEVALUE"
  (fn [args ctx]
    (def s (formula-eval/eval (get args 0) ctx))
    (def parts (string/split ":" s))
    (def h (scan-number (get parts 0)))
    (def m (scan-number (or (get parts 1) "0")))
    (def sec (scan-number (or (get parts 2) "0")))
    (formula-eval/hms->fraction h m sec)))
