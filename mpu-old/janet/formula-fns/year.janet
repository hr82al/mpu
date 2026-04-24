(formula-eval/register "YEAR"
  (fn [args ctx]
    ((formula-eval/serial->date (formula-eval/eval (get args 0) ctx)) :year)))
