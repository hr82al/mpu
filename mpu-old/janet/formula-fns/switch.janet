# SWITCH(expression, case1, value1, [case2, value2, …], [default])
# https://support.google.com/docs/answer/9670514

(formula-eval/register "SWITCH"
  (fn [args ctx]
    (when (< (length args) 3)
      (error "SWITCH needs at least (expr, case, value)"))
    (def expr (formula-eval/eval (get args 0) ctx))
    (def n (length args))
    (var i 1)
    (var result nil)
    (var matched false)
    (while (and (not matched) (<= (+ i 1) (- n 1)))
      (def case-v (formula-eval/eval (get args i) ctx))
      (when (= case-v expr)
        (set result (formula-eval/eval (get args (+ i 1)) ctx))
        (set matched true))
      (+= i 2))
    (cond
      matched result
      (= i (- n 1))   # trailing default
      (formula-eval/eval (get args i) ctx)
      (error "SWITCH: no case matched and no default provided"))))
