# JOIN(separator, value_or_array, …) — flatten and join with separator.
(formula-eval/register "JOIN"
  (fn [args ctx]
    (when (< (length args) 2) (error "JOIN needs (separator, values…)"))
    (def sep (string (formula-eval/eval (get args 0) ctx)))
    (def items @[])
    (defn walk [v]
      (cond
        (nil? v) nil
        (indexed? v) (each e v (walk e))
        (array/push items (string v))))
    (for i 1 (length args)
      (walk (formula-eval/eval (get args i) ctx)))
    (string/join items sep)))
