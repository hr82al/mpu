# PROPER(text) — capitalize first letter of each word, lowercase the rest.
(formula-eval/register "PROPER"
  (fn [args ctx]
    (def s (string (formula-eval/eval (get args 0) ctx)))
    (def out @"")
    (var at-start true)
    (each c s
      (cond
        (or (= c (chr " ")) (= c (chr "\t")))
        (do (buffer/push-byte out c) (set at-start true))
        at-start
        (do (buffer/push-byte out (first (string/ascii-upper (string/from-bytes c))))
            (set at-start false))
        (buffer/push-byte out (first (string/ascii-lower (string/from-bytes c))))))
    (string out)))
