(defn- gcd [a b] (if (zero? b) (math/abs a) (gcd b (mod a b))))
(defn- lcm [a b] (if (zero? a) 0 (math/abs (/ (* a b) (gcd a b)))))
(formula-eval/register "LCM"
  (fn [args ctx]
    (def nums (formula-eval/collect-numbers args ctx))
    (reduce lcm (get nums 0) (array/slice nums 1))))
