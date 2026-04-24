# Shared truthy predicate for logical ops. Sheets treats 0 / "" / FALSE
# / nil as falsy; everything else as truthy.

(defn formula-eval/truthy? [v]
  (not (or (nil? v) (= v false) (= v 0) (= v ""))))
