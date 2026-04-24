# TYPE(value) — Sheets type code: 1 number, 2 text, 4 logical, 16 error,
# 64 array.
(formula-eval/register "TYPE"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (cond
      (number? v)   1
      (string? v)   2
      (boolean? v)  4
      (= v :na)     16
      (indexed? v)  64
      16)))
