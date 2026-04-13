# SPLIT(text, delimiter, [split_by_each], [remove_empty_text])
# Minimal: treats delimiter as a literal (not regex); returns array.
(formula-eval/register "SPLIT"
  (fn [args ctx]
    (def s   (string (formula-eval/eval (get args 0) ctx)))
    (def sep (string (formula-eval/eval (get args 1) ctx)))
    (def parts (string/split sep s))
    (def keep-empty (if (>= (length args) 4)
                      (formula-eval/eval (get args 3) ctx) false))
    (if keep-empty
      (array ;parts)
      (array ;(filter (fn [p] (not (empty? p))) parts)))))
