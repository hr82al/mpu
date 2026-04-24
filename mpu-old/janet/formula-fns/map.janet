# MAP(array1, [array2, …], LAMBDA) — apply lambda elementwise.
# https://support.google.com/docs/answer/12568985
#
# The lambda takes as many parameters as there are input arrays.
# Shape of the first array is preserved; matching positions across
# arrays feed successive lambda parameters.

(defn- map-2d-cell [arrs lambda r c ctx]
  (def vals (map (fn [a] (get-in a [r c])) arrs))
  (formula-eval/invoke-lambda-with-values lambda vals ctx))

(formula-eval/register "MAP"
  (fn [args ctx]
    (when (< (length args) 2)
      (error "MAP needs (array, …, lambda)"))
    (def lam (formula-eval/eval (get args (- (length args) 1)) ctx))
    (unless (and (indexed? lam) (= (get lam 0) :lambda))
      (errorf "MAP: last arg must be a LAMBDA, got %j" lam))
    (def arrs
      (map (fn [i] (formula-eval/eval (get args i) ctx))
           (range (- (length args) 1))))
    (def first-arr (get arrs 0))
    (unless (indexed? first-arr)
      (errorf "MAP: first arg must be an array, got %j" first-arr))
    (def n (length first-arr))
    (def r0 (get first-arr 0))
    (def m (if (indexed? r0) (length r0) 1))
    (map (fn [r]
           (map (fn [c] (map-2d-cell arrs lam r c ctx))
                (range m)))
         (range n))))
