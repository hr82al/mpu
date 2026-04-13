(formula-eval/register "NOW"
  (fn [args ctx]
    (+ formula-eval/*sheets-epoch-offset* (/ (os/time) 86400))))
