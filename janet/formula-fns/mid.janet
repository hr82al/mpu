# MID(string, start, length) — start is 1-based.
(formula-eval/register "MID"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (def start (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def len   (math/trunc (formula-eval/eval (get args 2) ctx)))
    (def i (max 0 (- start 1)))
    (string/slice s i (min (length s) (+ i len)))))
