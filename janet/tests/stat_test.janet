# Statistical / range-math tests, expected values validated against Sheets.
#   mpu repl janet/tests/stat_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))
(defn- ≈ [a b] (< (math/abs (- a b)) 1e-9))

# AVERAGE / COUNT / COUNTA / COUNTBLANK
(assert (= 3 (r "=AVERAGE(1,2,3,4,5)"))                 "AVERAGE 1..5 = 3")
(assert (= 4 (r "=COUNT(1,2,3,\"hi\",TRUE)"))           "COUNT counts numbers + bools")
(assert (= 5 (r "=COUNTA(1,2,3,\"hi\",TRUE)"))          "COUNTA counts non-empty")
(assert (= 2 (r "=COUNTBLANK({1,\"\",\"\",2})"))        "COUNTBLANK")

# COUNTIF / SUMIF / AVERAGEIF with criteria string
(assert (= 3 (r "=COUNTIF({1,2,3,4,5},\">2\")"))        "COUNTIF >2")
(assert (= 2 (r "=COUNTIF({\"a\",\"b\",\"a\",\"c\"},\"a\")")) "COUNTIF eq")
(assert (= 12 (r "=SUMIF({1,2,3,4,5},\">2\")"))         "SUMIF >2")
(assert (= 4 (r "=AVERAGEIF({1,2,3,4,5},\">2\")"))      "AVERAGEIF >2 = avg(3,4,5)")

# MEDIAN / MODE
(assert (= 3 (r "=MEDIAN(1,2,3,4,5)"))                  "MEDIAN odd")
(assert (= 2.5 (r "=MEDIAN(1,2,3,4)"))                  "MEDIAN even")
(assert (= 4 (r "=MODE(1,2,2,3,4,4,4)"))                "MODE")

# Sample vs population variance / stdev
(assert (≈ 1.5811388300841898 (r "=STDEV(1,2,3,4,5)"))  "STDEV sample")
(assert (≈ 1.4142135623730951 (r "=STDEVP(1,2,3,4,5)")) "STDEVP population")
(assert (= 2.5 (r "=VAR(1,2,3,4,5)"))                   "VAR sample")
(assert (= 2   (r "=VARP(1,2,3,4,5)"))                  "VARP population")

# Integer helpers
(assert (= 4   (r "=GCD(12,8)"))                        "GCD")
(assert (= 12  (r "=LCM(4,6)"))                         "LCM")
(assert (= 120 (r "=FACT(5)"))                          "FACT 5 = 120")
(assert (= 10  (r "=COMBIN(5,2)"))                      "COMBIN 5 2")
(assert (= 20  (r "=PERMUT(5,2)"))                      "PERMUT 5 2")

# Ordering
(assert (= 5 (r "=LARGE({3,1,4,1,5,9,2,6},3)"))         "LARGE 3rd from top")
(assert (= 2 (r "=SMALL({3,1,4,1,5,9,2,6},3)"))         "SMALL 3rd from bottom")
(assert (= 3 (r "=RANK(5,{3,1,4,1,5,9,2,6})"))          "RANK desc (1=highest)")
(assert (= 3 (r "=PERCENTILE({1,2,3,4,5},0.5)"))        "PERCENTILE 50%")
(assert (= 2.75 (r "=QUARTILE({1,2,3,4,5,6,7,8},1)"))   "QUARTILE Q1")

# Operator helpers
(assert (= 7  (r "=MINUS(10,3)"))                       "MINUS")
(assert (= 2.5 (r "=DIVIDE(10,4)"))                     "DIVIDE")
(assert (= 42 (r "=MULTIPLY(6,7)"))                     "MULTIPLY")
(assert (= 7  (r "=ADD(3,4)"))                          "ADD")

(print "stat_test: all assertions passed")
