# ADDRESS(row, col, [abs_mode]) — produce an A1-style address.
#   abs_mode: 1 (default) $A$1 both absolute
#             2 A$1 row abs
#             3 $A1 col abs
#             4 A1 fully relative
(defn- col-to-letters [c]
  (def b @"")
  (var v c)
  (while (pos? v)
    (def rem (mod (- v 1) 26))
    (buffer/push-byte b (+ (chr "A") rem))
    (set v (math/floor (/ (- v 1) 26))))
  (string/reverse (string b)))

(formula-eval/register "ADDRESS"
  (fn [args ctx]
    (def row (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def col (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def mode (if (>= (length args) 3)
                (math/trunc (formula-eval/eval (get args 2) ctx)) 1))
    (def col-abs (or (= mode 1) (= mode 3)))
    (def row-abs (or (= mode 1) (= mode 2)))
    (string (if col-abs "$" "") (col-to-letters col)
            (if row-abs "$" "") row)))
