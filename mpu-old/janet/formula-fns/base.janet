# BASE(value, radix, [min_length]) — only radix 2..36.
(formula-eval/register "BASE"
  (fn [args ctx]
    (def n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def r (math/trunc (formula-eval/eval (get args 1) ctx)))
    (when (or (< r 2) (> r 36)) (error "BASE: radix must be 2..36"))
    (def digits "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    (if (zero? n) "0"
      (let [b @""]
        (var v (math/abs n))
        (while (pos? v)
          (buffer/push-byte b (get digits (mod v r)))
          (set v (math/floor (/ v r))))
        (string/reverse (string b))))))
