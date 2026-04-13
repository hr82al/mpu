(formula-eval/register "MONTH"
  (fn [args ctx]
    (+ 1 ((formula-eval/serial->date (formula-eval/eval (get args 0) ctx)) :month))))
