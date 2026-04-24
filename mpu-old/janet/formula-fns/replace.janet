# REPLACE(text, position, length, new_text) — position is 1-based.
(formula-eval/register "REPLACE"
  (fn [args ctx]
    (def s   (string (formula-eval/eval (get args 0) ctx)))
    (def pos (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def ln  (math/trunc (formula-eval/eval (get args 2) ctx)))
    (def rpl (string (formula-eval/eval (get args 3) ctx)))
    (def i (max 0 (- pos 1)))
    (def j (min (length s) (+ i ln)))
    (string (string/slice s 0 i) rpl (string/slice s j))))
