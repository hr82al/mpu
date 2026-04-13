# Shared date helpers — pure arithmetic, no timezone surprises.
#
# Sheets serial numbers: serial 1 = 1900-01-01, Lotus-bug: serial 60 is
# a phantom 1900-02-29. After Mar 1 1900 Sheets adds +1 to match Gregorian.
# Epoch shift: (+ unix-days 25569) still works for NOW(), but DATE
# arithmetic should go through these helpers.

(def formula-eval/*sheets-epoch-offset* 25569)

(def- days-before-month       [0 31 59 90 120 151 181 212 243 273 304 334])
(def- days-before-month-leap  [0 31 60 91 121 152 182 213 244 274 305 335])

(defn- is-leap [y]
  (or (and (zero? (mod y 4)) (not (zero? (mod y 100))))
      (zero? (mod y 400))))

(defn formula-eval/ymd->serial [y m d]
  (var days 0)
  (for yy 1900 y
    (+= days (if (is-leap yy) 366 365)))
  (+= days (get (if (is-leap y) days-before-month-leap days-before-month) (- m 1)))
  (+= days (- d 1))
  (+= days 1)                                    # serial 1 = 1900-01-01
  (when (or (> y 1900) (and (= y 1900) (> m 2)))
    (+= days 1))                                 # Lotus-bug compensation
  days)

(defn formula-eval/serial->date [serial]
  (def s (math/floor serial))
  (var n (if (>= s 61) (- s 2) (- s 1)))         # Gregorian day# from 1900-01-01
  (var y 1900)
  (var yl (if (is-leap y) 366 365))
  (while (>= n yl)
    (-= n yl) (++ y)
    (set yl (if (is-leap y) 366 365)))
  (def table (if (is-leap y) days-before-month-leap days-before-month))
  (var m 1)
  (while (and (< m 12) (>= n (get table m)))
    (++ m))
  (-= n (get table (- m 1)))
  # Weekday: 1900-01-01 was Monday; use Gregorian day count + offset 1 so
  # Sunday=0, Monday=1, …, Saturday=6 (matches Janet os/date :week-day).
  (def greg-days (if (>= s 61) (- s 2) (- s 1)))
  (def wd (mod (+ greg-days 1) 7))
  @{:year y :month (- m 1) :month-day n :week-day wd})

(defn formula-eval/hms->fraction [h m s]
  (/ (+ (* h 3600) (* m 60) s) 86400))
