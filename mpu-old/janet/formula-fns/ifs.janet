# IFS(condition1, value1, [condition2, value2, …])
# https://support.google.com/docs/answer/7014145

(formula-eval/register "IFS"
  (fn [args ctx]
    (when (or (empty? args) (odd? (length args)))
      (error "IFS needs an even number of args ≥ 2"))
    (var i 0)
    (var result nil)
    (var matched false)
    (while (and (not matched) (< i (length args)))
      (when (formula-eval/truthy? (formula-eval/eval (get args i) ctx))
        (set result (formula-eval/eval (get args (+ i 1)) ctx))
        (set matched true))
      (+= i 2))
    (if matched result (error "IFS: no condition matched"))))
