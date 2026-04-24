# TEXTJOIN(separator, ignore_empty, value1, [value2, …])
(formula-eval/register "TEXTJOIN"
  (fn [args ctx]
    (def sep (string (formula-eval/eval (get args 0) ctx)))
    (def ignore-empty (formula-eval/truthy?
                        (formula-eval/eval (get args 1) ctx)))
    (def parts @[])
    (defn walk [v]
      (cond
        (nil? v) (unless ignore-empty (array/push parts ""))
        (indexed? v) (each e v (walk e))
        (and (string? v) (empty? v))
        (unless ignore-empty (array/push parts ""))
        (array/push parts (string v))))
    (for i 2 (length args)
      (walk (formula-eval/eval (get args i) ctx)))
    (string/join parts sep)))
