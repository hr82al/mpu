# TEXT(number, format) — minimal: just stringify.
# Real Sheets TEXT handles locale, date patterns, number formats. For now
# we return `string(value)`; extend with pattern handling as needed.

(formula-eval/register "TEXT"
  (fn [args ctx]
    (string (formula-eval/eval (get args 0) ctx))))
