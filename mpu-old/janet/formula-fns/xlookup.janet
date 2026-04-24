# XLOOKUP(search_key, lookup_range, result_range,
#         [missing_value], [match_mode], [search_mode])
# https://support.google.com/docs/answer/12937038
#
# Minimal semantics:
#   * match_mode = 0 (exact only) — other modes (-1/1/2) not yet
#     implemented and will ignore their argument.
#   * search_mode = 1 (first-to-last) — binary / reverse not yet wired.
#   * lookup_range treated as 1-D (flattens single-column 2D).
#   * result_range of the same dimensionality as lookup_range: returns
#     the aligned element; if result is 2-D with multiple columns,
#     returns the whole row.

(defn- flatten-col [arr]
  # Accept either a flat 1-D or a single-column 2-D array.
  (cond
    (not (indexed? arr)) @[arr]
    (and (indexed? (get arr 0)) (= (length (get arr 0)) 1))
    (map (fn [r] (get r 0)) arr)
    arr))

(formula-eval/register "XLOOKUP"
  (fn [args ctx]
    (when (< (length args) 3)
      (error "XLOOKUP needs (search_key, lookup_range, result_range, …)"))
    (def key (formula-eval/eval (get args 0) ctx))
    (def lookup-raw (formula-eval/eval (get args 1) ctx))
    (def result (formula-eval/eval (get args 2) ctx))
    (def fallback (if (>= (length args) 4)
                    (formula-eval/eval (get args 3) ctx)))
    (def lookup (flatten-col lookup-raw))
    (var hit nil)
    (var i 0)
    (def n (length lookup))
    (while (and (nil? hit) (< i n))
      (when (= (get lookup i) key) (set hit i))
      (++ i))
    (if (nil? hit)
      (if (nil? fallback) :na fallback)
      (let [row0 (get result 0)]
        (if (and (indexed? row0) (> (length row0) 1))
          (get result hit)       # 2-D with >1 col → whole row
          (let [flat (flatten-col result)]
            (get flat hit)))))))
