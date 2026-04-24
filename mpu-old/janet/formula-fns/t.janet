# T(value) — passthrough for text, "" for anything else.
(formula-eval/register "T"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (if (string? v) v "")))
