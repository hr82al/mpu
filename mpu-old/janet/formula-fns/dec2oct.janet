(formula-eval/register "DEC2OCT"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (string/format "%o" n)))
