# formula-finder.janet — locate the formula cell that produced a value.
#
# A spilled-array formula lives in one cell but writes values into many
# others (e.g. =ARRAYFORMULA(R4:T6+1) at R4 fills R4…T6). This module
# finds the source cell given a target address.
#
# Loaded at VM boot via loadJanetScripts. Exposes pure functions; I/O
# and cobra plumbing stay in the `commands/ss-analyze.janet` wrapper.
#
#   (formula-finder/cell->rc "T6")      → [6 20]
#   (formula-finder/find-source m "T6") → ["R4" "=ARRAYFORMULA(...)"] or nil

(defn formula-finder/cell->rc
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

(defn formula-finder/lookup-cell
  "Return the cell table whose \"a\" field equals addr, or nil."
  [merged addr]
  (var found nil)
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (when (= (get cell "a") addr)
          (set found cell)))))
  found)

(defn- formula-finder/spill-width
  "Return the horizontal spill width of the formula at (fr, fc): the number
  of consecutive cells in row fr (starting at fc+1) that are present in the
  data and carry no formula of their own.

  Two corrections versus a naive scan:

  1. No value filter — spill cells produced by MAP/LET may legitimately hold
     an empty string in the formula's home row while containing real data in
     all rows below.  We rely on the cell's *presence* in the data (batch-get-all
     only returns occupied cells) rather than its value.

  2. Per-row formula guard — if the cell directly below the candidate formula
     (fr+1, fc) also carries a formula, the candidate is a single-cell
     repeated-per-row formula (e.g. the same LET expression copied down
     column I), not an array formula.  Such formulas produce exactly one value
     and cannot spill horizontally into adjacent columns; return 0 immediately."
  [merged fr fc]
  # Build a [row col] → cell map covering rows fr and fr+1.
  (def cells @{})
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (def a (get cell "a"))
        (when a
          (def ok (protect (formula-finder/cell->rc a)))
          (when (get ok 0)
            (def [r c] (get ok 1))
            (put cells [r c] cell))))))
  # Per-row guard: if (fr+1, fc) has a formula, this formula is per-row → sw=0.
  (def below (get cells [(+ fr 1) fc]))
  (def below-f (and below (get below "f")))
  (when (and (string? below-f) (not (empty? below-f)))
    (break 0))
  # Count consecutive present-but-no-formula cells in row fr right of fc.
  (var w 0)
  (var c (+ fc 1))
  (var going true)
  (while going
    (def cell (get cells [fr c]))
    (def f (and cell (get cell "f")))
    (if (and cell (or (nil? f) (= f "")))   # cell exists, no formula
      (do (++ w) (++ c))
      (set going false)))
  w)

(defn formula-finder/find-source
  "Locate the formula cell that fills `target`.

  Two-group algorithm (prevents a nearer unrelated formula from winning over
  a formula whose multi-column spill actually covers the target):

    Group A — formula cells that have a detected horizontal spill (≥1
              spilled cells in the same row) AND whose spill covers the
              target column: fc ≤ tc ≤ fc+sw.
              Winner: smallest vertical distance (tr-fr), then horizontal.

    Group B — formula cells with no horizontal spill (sw=0).
              Used only when group A is empty.
              Winner: smallest Manhattan distance (original behaviour).

  A formula with sw>0 that does NOT cover tc is excluded from both groups
  (e.g. it writes columns fc..fc+sw-1, and the target is to the right)."
  [merged target]
  (def [tr tc] (formula-finder/cell->rc target))
  # Group A (spill-covers target column)
  (var a-addr nil) (var a-formula nil)
  (var a-vdist nil) (var a-hdist nil)
  # Group B (no horizontal spill — fallback)
  (var b-addr nil) (var b-formula nil)
  (var b-dist nil)
  (each rng merged
    (each row (get rng "values")
      (each cell row
        (def f (get cell "f"))
        (when (and (string? f) (not (empty? f)))
          (def a (get cell "a"))
          (def [r c] (formula-finder/cell->rc a))
          (when (and (<= r tr) (<= c tc))
            (def sw (formula-finder/spill-width merged r c))
            (cond
              # Group A: has horizontal spill that covers tc
              (and (> sw 0) (>= (+ c sw) tc))
              (let [vd (- tr r) hd (- tc c)]
                (when (or (nil? a-vdist)
                          (< vd a-vdist)
                          (and (= vd a-vdist) (< hd a-hdist)))
                  (set a-vdist vd) (set a-hdist hd)
                  (set a-addr a)  (set a-formula f)))
              # Group B: no horizontal spill (plain / vertical-only)
              (= sw 0)
              (let [dist (+ (- tr r) (- tc c))]
                (when (or (nil? b-dist) (< dist b-dist))
                  (set b-dist dist)
                  (set b-addr a) (set b-formula f)))))))))
  (if a-addr
    [a-addr a-formula]
    (when b-addr [b-addr b-formula])))

(defn formula-finder/resolve
  "Explain where target's value comes from:
     [:formula src-addr formula]  — produced by formula at src-addr
     [:direct  target    value]   — direct input in target cell itself
     nil                          — target has neither formula nor value"
  [merged target]
  (def src (formula-finder/find-source merged target))
  (if src
    [:formula (get src 0) (get src 1)]
    (let [own (formula-finder/lookup-cell merged target)
          v   (and own (get own "v"))]
      (if (or (nil? v) (and (string? v) (empty? v)))
        nil
        [:direct target v]))))
