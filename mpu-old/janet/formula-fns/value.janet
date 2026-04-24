# VALUE(text) — parse a string as a number.
(formula-eval/register "VALUE"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (cond
      (number? v) v
      (string? v)
      (or (scan-number v)
          (errorf "VALUE: cannot parse %j as number" v))
      (errorf "VALUE: expected string or number, got %j" v))))
