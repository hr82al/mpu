# UNIQUE(range) — preserve order of first occurrence.
(formula-eval/register "UNIQUE"
  (fn [args ctx]
    (def data (formula-eval/flatten-any
                (formula-eval/eval (get args 0) ctx)))
    (def seen @{})
    (def out @[])
    (each v data
      (unless (get seen v)
        (put seen v true)
        (array/push out v)))
    out))
