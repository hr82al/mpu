# MAKEARRAY(rows, cols, LAMBDA(r, c, …))
(formula-eval/register "MAKEARRAY"
  (fn [args ctx]
    (def rows (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def cols (math/trunc (formula-eval/eval (get args 1) ctx)))
    (def lam (formula-eval/eval (get args 2) ctx))
    (def out @[])
    (for r 1 (+ rows 1)
      (def row @[])
      (for c 1 (+ cols 1)
        (array/push row
          (formula-eval/invoke-lambda-with-values lam [r c] ctx)))
      (array/push out row))
    out))
