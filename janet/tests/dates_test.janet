# Date/time tests — expected values validated against live Google Sheets.
# Sheets stores dates as serial numbers (days since 1899-12-30, epoch = 0).
#   mpu repl janet/tests/dates_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ── DATE / day-of extractors ────────────────────────────────────
(assert (= 45306 (r "=DATE(2024,1,15)"))       "DATE(2024,1,15) = 45306")
(assert (= 15    (r "=DAY(DATE(2024,1,15))"))  "DAY")
(assert (= 3     (r "=MONTH(DATE(2024,3,10))")) "MONTH")
(assert (= 2024  (r "=YEAR(DATE(2024,3,10))"))  "YEAR")
(assert (= 2     (r "=WEEKDAY(DATE(2024,1,15))")) "WEEKDAY (2024-01-15 Mon=2)")

# ── DATEVALUE / TIMEVALUE / TIME ────────────────────────────────
(assert (= 45306 (r "=DATEVALUE(\"2024-01-15\")")) "DATEVALUE ISO")
(assert (= 10    (r "=HOUR(TIMEVALUE(\"10:30:45\"))")) "HOUR")
(assert (= 30    (r "=MINUTE(TIMEVALUE(\"10:30:45\"))")) "MINUTE")
(assert (= 45    (r "=SECOND(TIMEVALUE(\"10:30:45\"))")) "SECOND")
# TIME(h,m,s) → fraction of a day, e.g. 10:30:45 ≈ 0.43802…
(assert (< (math/abs (- 0.4380208333333 (r "=TIME(10,30,45)"))) 1e-9)
        "TIME(10,30,45)")

# ── arithmetic on dates ─────────────────────────────────────────
(assert (= 5  (r "=DAYS(DATE(2024,1,20),DATE(2024,1,15))")) "DAYS")
(assert (= 4  (r "=DATEDIF(DATE(2020,1,1),DATE(2024,1,1),\"Y\")")) "DATEDIF Y")
(assert (= 51 (r "=DATEDIF(DATE(2020,1,1),DATE(2024,4,1),\"M\")")) "DATEDIF M")
(assert (= 19 (r "=DATEDIF(DATE(2024,1,1),DATE(2024,1,20),\"D\")")) "DATEDIF D")

(assert (= 45397 (r "=EDATE(DATE(2024,1,15),3)"))  "EDATE +3m")
(assert (= 45214 (r "=EDATE(DATE(2024,1,15),-3)")) "EDATE -3m")
(assert (= 45351 (r "=EOMONTH(DATE(2024,2,5),0)")) "EOMONTH feb 2024 leap")
(assert (= 27    (r "=WEEKNUM(DATE(2024,7,4))"))   "WEEKNUM")
(assert (= 0.5   (r "=YEARFRAC(DATE(2024,1,1),DATE(2024,7,1))")) "YEARFRAC half")
(assert (= 10    (r "=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,12))")) "NETWORKDAYS")
(assert (= 45299 (r "=WORKDAY(DATE(2024,1,1),5)")) "WORKDAY")

# NOW / TODAY are time-dependent — verify only that they're numbers
(assert (number? (r "=NOW()"))   "NOW is number")
(assert (number? (r "=TODAY()")) "TODAY is number")

(print "dates_test: all assertions passed")
