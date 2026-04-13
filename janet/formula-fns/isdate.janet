# ISDATE(value) — minimal: matches YYYY-MM-DD ISO strings.
# Full Sheets ISDATE accepts many locale-specific formats; extend as needed.

(def- iso-date-peg
  ~{:main (* :d :d :d :d "-" :d :d "-" :d :d -1)})

(formula-eval/register "ISDATE"
  (fn [args ctx]
    (def v (formula-eval/eval (get args 0) ctx))
    (if (string? v)
      (not (nil? (peg/match iso-date-peg v)))
      false)))
