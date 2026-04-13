# SUBSTITUTE(text, search_for, replace_with, [occurrence]) — replace all
# occurrences by default; if `occurrence` given, replace only the Nth.
(formula-eval/register "SUBSTITUTE"
  (fn [args ctx]
    (def s    (string (formula-eval/eval (get args 0) ctx)))
    (def nd   (string (formula-eval/eval (get args 1) ctx)))
    (def rpl  (string (formula-eval/eval (get args 2) ctx)))
    (def nth  (if (>= (length args) 4)
                (math/trunc (formula-eval/eval (get args 3) ctx))))
    (if (empty? nd)
      s
      (if nth
        (do
          (def b @"")
          (var i 0)
          (var count 0)
          (def n (length s))
          (def m (length nd))
          (while (< i n)
            (if (and (<= (+ i m) n)
                     (= nd (string/slice s i (+ i m))))
              (do (++ count)
                  (if (= count nth)
                    (do (buffer/push-string b rpl) (+= i m))
                    (do (buffer/push-byte b (get s i)) (++ i))))
              (do (buffer/push-byte b (get s i)) (++ i))))
          (string b))
        (string/replace-all nd rpl s)))))
