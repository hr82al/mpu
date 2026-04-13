(formula-eval/register "DEC2HEX"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (string/ascii-upper (string/format "%x" n))))
