(formula-eval/register "CHOOSE"
  (fn [args ctx]
    (def idx (math/trunc (formula-eval/eval (get args 0) ctx)))
    (when (or (< idx 1) (>= idx (length args)))
      (errorf "CHOOSE: index %d out of range" idx))
    (formula-eval/eval (get args idx) ctx)))
