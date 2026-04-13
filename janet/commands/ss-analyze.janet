# ss-analyze — locate the formula cell that fills a given target cell.
# Usage: mpu ss-analyze -s <id> -n <sheet> -a <cell>
#
# Every flag except -a/--address is forwarded verbatim to
# mpu batch-get-all, so smart defaults (-s, -n) and forceCache keep
# working through the Go bridge without being re-implemented here.

(var- target nil)
(def- forwarded @[])

(var- i 0)
(def- argc (length *args*))
(while (< i argc)
  (def a (get *args* i))
  (cond
    (or (= a "-a") (= a "--address"))
    (do
      (set target (get *args* (+ i 1)))
      (+= i 2))
    (do (array/push forwarded a) (++ i))))

(unless target
  (error "ss-analyze: -a/--address is required (target cell, e.g. T6)"))

(def raw (mpu/batch-get-all ;forwarded))
(when (or (nil? raw) (empty? raw))
  (error "ss-analyze: mpu/batch-get-all returned no data"))

(def merged (json/decode raw))
(def src (formula-finder/find-source merged target))
(unless src
  (errorf "ss-analyze: no source formula found for %s" target))

(def [addr formula] src)
(printf "# %s → %s" target addr)
(printf "# raw: %s" formula)
(def ast
  (try (formula-parser/parse formula)
    ([e]
      (errorf "formula-parser failed on %s: %s\n  formula: %s"
              addr e formula))))
(printf "%j" ast)
