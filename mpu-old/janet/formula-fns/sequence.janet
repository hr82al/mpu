# SEQUENCE(rows, [cols], [start], [step])
(formula-eval/register "SEQUENCE"
  (fn [args ctx]
    (def rows (math/trunc (formula-eval/eval (get args 0) ctx)))
    (def cols (if (>= (length args) 2)
                (math/trunc (formula-eval/eval (get args 1) ctx)) 1))
    (def start (if (>= (length args) 3)
                 (formula-eval/eval (get args 2) ctx) 1))
    (def step (if (>= (length args) 4)
                (formula-eval/eval (get args 3) ctx) 1))
    (var v start)
    (def out @[])
    (for r 0 rows
      (def row @[])
      (for c 0 cols
        (array/push row v)
        (set v (+ v step)))
      (array/push out row))
    (if (and (= cols 1) (= rows 1))
      out
      (if (= cols 1)
        (map (fn [r] (get r 0)) out)
        out))))
