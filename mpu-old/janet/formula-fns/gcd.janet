(defn- gcd [a b] (if (zero? b) (math/abs a) (gcd b (mod a b))))
(formula-eval/register "GCD"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers args ctx))
    (reduce gcd (math/abs (get nums 0)) (array/slice nums 1))))
