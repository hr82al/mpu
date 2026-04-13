(formula-eval/register "REPT"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (def n (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def b @"")
    (for _ 0 n (buffer/push-string b s))
    (string b)))
