# ROMAN(n) — convert integer to Roman numeral (simplest form).
(def- roman-pairs
  [[1000 "M"] [900 "CM"] [500 "D"] [400 "CD"]
   [100 "C"] [90 "XC"] [50 "L"] [40 "XL"]
   [10 "X"] [9 "IX"] [5 "V"] [4 "IV"] [1 "I"]])

(formula-eval/register "ROMAN"
  (fn [args ctx]
    (var n (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def b @"")
    (each [v s] roman-pairs
      (while (>= n v)
        (buffer/push-string b s)
        (-= n v)))
    (string b)))
