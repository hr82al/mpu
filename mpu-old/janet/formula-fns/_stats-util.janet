# Shared helpers for STDEV/VAR family.
(defn formula-eval/collect-numbers [args ctx]
  (def out @[])
  (formula-eval/for-each-number args ctx (fn [v] (array/push out v)))
  out)

(defn formula-eval/mean [nums]
  (if (empty? nums) 0 (/ (sum nums) (length nums))))

(defn formula-eval/sum-sq-dev [nums]
  (def m (formula-eval/mean nums))
  (var s 0)
  (each v nums (+= s (* (- v m) (- v m))))
  s)
