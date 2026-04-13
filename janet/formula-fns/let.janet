# LET(name1, val1, name2, val2, …, final_expr) — Sheets local bindings.
#
# Evaluates each value expression in the progressively-built environment
# (earlier names visible to later ones, per Sheets docs), then returns
# the final expression. Supports nesting with closures for LAMBDA.

(formula-eval/register "LET"
  (fn [args ctx]
    (def n (length args))
    (when (or (< n 1) (even? n))
      (errorf "LET: odd number of args required (got %d)" n))
    (def env (if (get ctx :env) (table/clone (get ctx :env)) @{}))
    (var i 0)
    (while (< i (- n 1))
      (def name-ast (get args i))
      (def name (if (= (get name-ast 0) :name)
                  (get name-ast 1)
                  (errorf "LET: name expected, got %j" name-ast)))
      (def val (formula-eval/eval (get args (+ i 1))
                                  (do (def c (table/clone ctx))
                                      (put c :env env)
                                      c)))
      (put env name val)
      (+= i 2))
    (formula-eval/eval (get args (- n 1))
                       (do (def c (table/clone ctx))
                           (put c :env env)
                           c))))
