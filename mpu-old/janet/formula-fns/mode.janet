(formula-eval/register "MODE"
  (fn [args ctx]
    (def counts @{})
    (formula-eval/for-each-number args ctx
      (fn [v] (put counts v (+ 1 (or (get counts v) 0)))))
    (var best-v nil)
    (var best-c 0)
    (eachp [v c] counts
      (when (> c best-c) (set best-v v) (set best-c c)))
    (or best-v (error "MODE: no repeating value"))))
