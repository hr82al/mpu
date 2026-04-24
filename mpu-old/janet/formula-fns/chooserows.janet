# CHOOSEROWS(array, row_num1, [row_num2, …]) — pick rows from an array.
#
# Per https://support.google.com/docs/answer/13196659 :
#   * row_num is 1-based; negative counts from the end (-1 = last).
#   * Indices may repeat and appear in any order.
#   * At least one index is required.
#   * Out-of-range index is an error.

(defn- resolve-row-index [idx n-rows]
  # Truncate toward zero (Sheets behaviour for fractional indices).
  (def i (if (number? idx) (math/trunc idx)
             (errorf "CHOOSEROWS: index must be number, got %j" idx)))
  (def norm (if (< i 0) (+ n-rows i 1) i))
  (when (or (< norm 1) (> norm n-rows))
    (errorf "CHOOSEROWS: index %d out of range [1,%d] (or [-%d,-1])"
            i n-rows n-rows))
  norm)

(formula-eval/register "CHOOSEROWS"
  (fn [args ctx]
    (when (< (length args) 2)
      (error "CHOOSEROWS requires an array and at least one row index"))
    (def arr (formula-eval/eval (get args 0) ctx))
    (unless (indexed? arr)
      (errorf "CHOOSEROWS: first arg must be an array, got %j" arr))
    (def n-rows (length arr))
    (def out @[])
    (for i 1 (length args)
      (def raw (formula-eval/eval (get args i) ctx))
      (array/push out (get arr (- (resolve-row-index raw n-rows) 1))))
    out))
