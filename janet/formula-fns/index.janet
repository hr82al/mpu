# INDEX(reference, [row], [column]) — pick a cell / row / column.
# https://support.google.com/docs/answer/3098242
#
# Semantics:
#   INDEX(ref, r, c)  → ref[r][c]         (both 1-based)
#   INDEX(ref, r, 0)  → whole r-th row
#   INDEX(ref, r)     → whole r-th row (or single cell of 1D)
#   INDEX(ref, 0, c)  → whole c-th column
#   INDEX(ref, 0, 0)  → reference itself
#
# Empty argument slots (e.g. INDEX(ref,,c)) evaluate to nil and are
# treated as 0. For single-row/column refs INDEX(ref, i) returns the
# i-th element (1-D shortcut).

(defn- as-idx [v]
  (cond
    (number? v) (math/trunc v)
    (nil? v) 0
    0))

(formula-eval/register "INDEX"
  (fn [args ctx]
    (when (empty? args) (error "INDEX needs a reference"))
    (def ref (formula-eval/eval (get args 0) ctx))
    (def row (as-idx (if (>= (length args) 2)
                       (formula-eval/eval (get args 1) ctx))))
    (def col (as-idx (if (>= (length args) 3)
                       (formula-eval/eval (get args 2) ctx))))
    (if (not (indexed? ref))
      ref
      (let [n (length ref)
            row0 (get ref 0)
            m (if (indexed? row0) (length row0) 1)
            single-row? (= n 1)
            single-col? (= m 1)]
        (cond
          (and (pos? row) (pos? col))
          (get-in ref [(- row 1) (- col 1)])

          (pos? row)
          (cond
            single-row? (get-in ref [0 (- row 1)])   # 1-D row shortcut
            single-col? (get-in ref [(- row 1) 0])   # 1-D col shortcut
            (get ref (- row 1)))                     # whole row

          (pos? col)
          (if single-row?
            (get-in ref [0 (- col 1)])
            (map (fn [r] (get r (- col 1))) ref))

          ref)))))
