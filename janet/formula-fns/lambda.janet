# LAMBDA(param1, param2, …, body) — returns a closure value.
#
# Captures the surrounding env so LET-bound names remain visible when
# the lambda is later invoked (see formula-eval/invoke-lambda).

(formula-eval/register "LAMBDA"
  (fn [args ctx]
    (def n (length args))
    (when (< n 1) (error "LAMBDA: body required"))
    (def params @[])
    (for i 0 (- n 1)
      (def p (get args i))
      (if (= (get p 0) :name)
        (array/push params (get p 1))
        (errorf "LAMBDA: param must be a :name, got %j" p)))
    (def body (get args (- n 1)))
    [:lambda (tuple/slice params) body @{:env (get ctx :env)}]))
