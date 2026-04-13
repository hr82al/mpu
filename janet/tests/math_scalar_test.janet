# Tests for scalar math (ABS ROUND ROUNDUP ROUNDDOWN FLOOR CEILING INT
# TRUNC SIGN MIN MAX POWER SQRT MOD PI PRODUCT EXP LN LOG LOG10).
#   mpu repl janet/tests/math_scalar_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

(defn- ≈ [a b] (< (math/abs (- a b)) 1e-9))

# ABS
(assert (= 5 (r "=ABS(-5)"))                       "ABS neg")
(assert (= 5 (r "=ABS(5)"))                        "ABS pos")

# ROUND
(assert (= 3    (r "=ROUND(3.4)"))                 "3.4 → 3")
(assert (= 4    (r "=ROUND(3.5)"))                 "3.5 → 4 (half up)")
(assert (= 3.14 (r "=ROUND(3.14159, 2)"))          "to 2 decimals")
(assert (= 3140 (r "=ROUND(3141.59, -1)"))         "to tens")

# ROUNDUP / ROUNDDOWN (toward/away zero)
(assert (= 4 (r "=ROUNDUP(3.1)"))                  "up")
(assert (= -4 (r "=ROUNDUP(-3.1)"))                "up neg → more neg")
(assert (= 3 (r "=ROUNDDOWN(3.9)"))                "down")
(assert (= -3 (r "=ROUNDDOWN(-3.9)"))              "down neg → less neg")

# FLOOR / CEILING — to nearest multiple
(assert (= 4 (r "=FLOOR(4.9)"))                    "floor default=1")
(assert (= 5 (r "=CEILING(4.1)"))                  "ceiling default=1")
(assert (= 10 (r "=FLOOR(13, 5)"))                 "floor 13 to 5s = 10")
(assert (= 15 (r "=CEILING(13, 5)"))               "ceiling 13 to 5s = 15")

# INT / TRUNC / SIGN
(assert (= 3 (r "=INT(3.7)"))                      "INT 3.7 → 3")
(assert (= -4 (r "=INT(-3.7)"))                    "INT toward -inf")
(assert (= 3 (r "=TRUNC(3.7)"))                    "TRUNC 3.7 → 3")
(assert (= -3 (r "=TRUNC(-3.7)"))                  "TRUNC -3.7 → -3 (toward 0)")
(assert (= 1 (r "=SIGN(5)"))                       "SIGN pos")
(assert (= -1 (r "=SIGN(-2)"))                     "SIGN neg")
(assert (= 0 (r "=SIGN(0)"))                       "SIGN zero")

# MIN / MAX across scalars and ranges
(assert (= 1 (r "=MIN(3, 1, 5)"))                  "MIN")
(assert (= 5 (r "=MAX(3, 1, 5)"))                  "MAX")

# POWER / SQRT / MOD
(assert (= 8 (r "=POWER(2, 3)"))                   "POWER")
(assert (= 3 (r "=SQRT(9)"))                       "SQRT")
(assert (= 1 (r "=MOD(10, 3)"))                    "MOD")

# PI
(assert (≈ 3.14159265358979 (r "=PI()"))           "PI()")

# PRODUCT
(assert (= 24 (r "=PRODUCT(2, 3, 4)"))             "PRODUCT")

# EXP / LN / LOG / LOG10
(assert (≈ (math/exp 1) (r "=EXP(1)"))             "EXP(1) = e")
(assert (≈ 0 (r "=LN(1)"))                         "LN(1) = 0")
(assert (≈ 2 (r "=LOG(100)"))                      "LOG default base 10")
(assert (≈ 3 (r "=LOG(8, 2)"))                     "LOG base 2 of 8")
(assert (≈ 2 (r "=LOG10(100)"))                    "LOG10(100)")

(print "math_scalar_test: all assertions passed")
