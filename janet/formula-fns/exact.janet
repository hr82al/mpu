# EXACT(s1, s2) — case-sensitive equality.
(formula-eval/register "EXACT"
  (fn [args ctx]
    (= (string (formula-eval/eval (get args 0) ctx))
       (string (formula-eval/eval (get args 1) ctx)))))
