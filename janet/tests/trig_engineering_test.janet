# Trig, additional math, and engineering — Sheets-validated.
#   mpu repl janet/tests/trig_engineering_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))
(defn- ≈ [a b] (< (math/abs (- a b)) 1e-9))

# Extra math
(assert (= 3  (r "=QUOTIENT(10,3)"))        "QUOTIENT")
(assert (= 9  (r "=MROUND(10,3)"))          "MROUND 10 → nearest multiple of 3 = 9")
(assert (= 4  (r "=EVEN(3)"))               "EVEN round-up to even")
(assert (= 5  (r "=ODD(4)"))                "ODD round-up to odd")
(assert (= 25 (r "=SUMSQ(3,4)"))            "SUMSQ 9+16")

# Trig
(assert (≈ (/ math/pi 4) (r "=ATAN(1)"))    "ATAN 1 = π/4")
(assert (≈ (/ math/pi 4) (r "=ATAN2(1,1)")) "ATAN2(1,1) = π/4")
(assert (= 1 (r "=SIN(PI()/2)"))            "SIN π/2")
(assert (= 1 (r "=COS(0)"))                 "COS 0")
(assert (= 0 (r "=TAN(0)"))                 "TAN 0")
(assert (= 180 (r "=DEGREES(PI())"))        "DEGREES π")
(assert (≈ math/pi (r "=RADIANS(180)"))     "RADIANS 180")

# Engineering: base conversions
(assert (= "1010" (r "=DEC2BIN(10)"))  "DEC2BIN 10")
(assert (= 10     (r "=BIN2DEC(1010)")) "BIN2DEC 1010")
(assert (= "FF"   (r "=DEC2HEX(255)")) "DEC2HEX 255")
(assert (= 255    (r "=HEX2DEC(\"FF\")")) "HEX2DEC FF")
(assert (= "10"   (r "=DEC2OCT(8)"))   "DEC2OCT 8")
(assert (= 8      (r "=OCT2DEC(10)"))  "OCT2DEC 10")
(assert (= "FF"   (r "=BASE(255,16)")) "BASE 16")

(print "trig_engineering_test: all assertions passed")
