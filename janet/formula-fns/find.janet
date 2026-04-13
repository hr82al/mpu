# FIND(search_for, text_to_search, [starting_at]) — 1-based, case-sensitive.
(formula-eval/register "FIND"
  (fn [args ctx]
    (def needle (string (formula-eval/eval (get args 0) ctx)))
    (def hay    (string (formula-eval/eval (get args 1) ctx)))
    (def start  (if (>= (length args) 3)
                  (max 0 (- (math/trunc (formula-eval/eval (get args 2) ctx)) 1))
                  0))
    (def idx (string/find needle hay start))
    (if idx (+ 1 idx) (error "FIND: substring not found"))))
