(formula-eval/register "DEC2BIN"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (if (zero? n) "0"
      (let [b @""]
        (var v (math/abs n))
        (while (pos? v)
          (buffer/push-byte b (+ (chr "0") (mod v 2)))
          (set v (math/floor (/ v 2))))
        (string/reverse (string b))))))
