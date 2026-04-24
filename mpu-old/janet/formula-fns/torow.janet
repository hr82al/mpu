# TOROW(array) — flatten to single row (Sheets returns 1×N 2-D; our
# callers already FLATTEN, so 1-D is acceptable here).
(formula-eval/register "TOROW"
  (fn [args ctx]
    (formula-eval/flatten-any (formula-eval/eval (get args 0) ctx))))
