# ISERROR(value) — true for this evaluator's :na sentinel and for Janet
# errors that bubble up from eval.
(formula-eval/register "ISERROR"
  (fn [args ctx]
    (def r (protect (formula-eval/eval (get args 0) ctx)))
    (cond
      (not (get r 0)) true            # Janet error
      (= (get r 1) :na) true          # NA sentinel
      false)))
