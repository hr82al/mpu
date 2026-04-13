# SEARCH — case-insensitive variant of FIND.
(formula-eval/register "SEARCH"
  (fn [args ctx]
    (def needle (string/ascii-lower
                  (string (formula-eval/eval (get args 0) ctx))))
    (def hay    (string/ascii-lower
                  (string (formula-eval/eval (get args 1) ctx))))
    (def start  (if (>= (length args) 3)
                  (max 0 (- (math/trunc (formula-eval/eval (get args 2) ctx)) 1))
                  0))
    (def idx (string/find needle hay start))
    (if idx (+ 1 idx) (error "SEARCH: substring not found"))))
