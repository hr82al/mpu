# CLEAN(text) — strip ASCII control chars (< 32).
(formula-eval/register "CLEAN"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (def b @"")
    (each c s (when (>= c 32) (buffer/push-byte b c)))
    (string b)))
