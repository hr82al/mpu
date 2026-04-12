# ss-analyze.janet — helpers for tracing cell data in a Google Sheet.
#
# Loaded at VM boot (see loadJanetScripts). Exposes pure functions; I/O
# and cobra plumbing stay in the `commands/ss-analyze.janet` wrapper.
#
#   (ss-analyze/cell->rc "T6")      → [6 20]
#   (ss-analyze/find-source m "T6") → "R4" or nil

(defn ss-analyze/cell->rc
  "Convert an A1-style address to [row col] (both 1-based). Errors on
  malformed input — the only valid shape is letters+digits."
  [addr]
  (def A (chr "A"))
  (def Z (chr "Z"))
  (def n (length addr))
  (var i 0)
  (while (and (< i n)
              (>= (get addr i) A)
              (<= (get addr i) Z))
    (++ i))
  (when (or (zero? i) (= i n))
    (errorf "invalid cell address: %s" addr))
  (def num (scan-number (string/slice addr i)))
  (unless num (errorf "invalid row number in %s" addr))
  (var col 0)
  (for k 0 i
    (set col (+ (* col 26) (- (get addr k) A) 1)))
  [num col])

(defn ss-analyze/find-source
  "Locate the nearest cell at (row ≤ tr, col ≤ tc) that carries a non-empty
  formula, given `merged` — the decoded output of mpu batch-get-all: an
  array of {\"range\" \"values\"} tables whose values are 2-D arrays of
  {\"a\" \"v\" \"f\"} cells.
  Returns [address formula] of that formula cell, or nil if none qualify.
  Ties resolve toward the smallest Manhattan distance from target."
  [merged target]
  (def [tr tc] (ss-analyze/cell->rc target))
  (var best-addr nil)
  (var best-formula nil)
  (var best-dist nil)
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (def f (get cell "f"))
        (when (and (string? f) (not (empty? f)))
          (def [r c] (ss-analyze/cell->rc (get cell "a")))
          (when (and (<= r tr) (<= c tc))
            (def dist (+ (- tr r) (- tc c)))
            (when (or (nil? best-dist) (< dist best-dist))
              (set best-dist dist)
              (set best-addr (get cell "a"))
              (set best-formula f)))))))
  (when best-addr [best-addr best-formula]))
