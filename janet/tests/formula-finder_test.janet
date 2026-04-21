# Pure-logic tests for formula-finder. Runs inside an mpu VM so the
# library is loaded via loadJanetScripts — no separate import needed.
#
# Usage (via Makefile target):
#   mpu repl janet/tests/formula-finder_test.janet
#
# Any (assert ...) failure raises a Janet error; script mode returns that
# error and the process exits non-zero, so `make test` fails loudly.

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT!A1:ZZZ" "values" cells})

# ── cell->rc ──────────────────────────────────────────────────────

(assert (deep= [1  1]  (formula-finder/cell->rc "A1"))   "A1  → [1 1]")
(assert (deep= [6  20] (formula-finder/cell->rc "T6"))   "T6  → [6 20]")
(assert (deep= [4  18] (formula-finder/cell->rc "R4"))   "R4  → [4 18]")
(assert (deep= [100 27] (formula-finder/cell->rc "AA100")) "AA100 → [100 27]")

# ── find-source: target is a spilled cell, source is up-left ─────
# This is the CLAUDE.md example — UNIT sheet, T6 ← R4.

(def merged-spill
  @[(range- @[
      @[(cell "R4" 42  "=ARRAYFORMULA(R4:T6 + 1)")]
      @[(cell "T6" "x" "")]])])

(assert (deep= ["R4" "=ARRAYFORMULA(R4:T6 + 1)"]
               (formula-finder/find-source merged-spill "T6"))
        "spilled T6 must resolve to [R4 formula]")

# ── find-source: target itself carries the formula ───────────────

(def merged-self
  @[(range- @[@[(cell "B2" 99 "=SUM(A1:A2)")]])])

(assert (deep= ["B2" "=SUM(A1:A2)"]
               (formula-finder/find-source merged-self "B2"))
        "B2 with its own formula must return [B2 formula]")

# ── find-source: no qualifying formula → nil ─────────────────────

(def merged-empty
  @[(range- @[@[(cell "A1" 1 "") (cell "B1" 2 "") (cell "C1" 3 "")]])])

(assert (nil? (formula-finder/find-source merged-empty "C3"))
        "no formula above-left of C3 → nil")

# ── find-source: formula to the right must NOT match ─────────────
# Spilled arrays only flow right/down, so a formula at Z1 cannot feed A5.

(def merged-right
  @[(range- @[
      @[(cell "Z1" 7  "=ARRAYFORMULA(Z1:Z9)")]
      @[(cell "A5" "v" "")]])])

(assert (nil? (formula-finder/find-source merged-right "A5"))
        "formula right of target must be ignored")

# ── find-source: closer candidate beats farther one ──────────────

(def merged-two
  @[(range- @[
      @[(cell "A1" "x" "=FAR()")]
      @[(cell "R4" "y" "=NEAR()")]
      @[(cell "T6" "v" "")]])])

(assert (deep= ["R4" "=NEAR()"] (formula-finder/find-source merged-two "T6"))
        "closer formula R4 must win over distant A1")

# ── resolve: formula / direct / nil discriminator ────────────────
# Direct-value cells must have no formula above-left, or the
# spill-heuristic would pick them up. Place direct values at A1
# (no room for anything up-left) and formula cells further down.

(def merged-mixed
  @[(range- @[
      @[(cell "A1" 10 "")]          # direct, nothing up-left
      @[(cell "B3" 2  "=1+1")]      # own formula
      @[(cell "D5" 2  "")]])])      # spilled from B3 (nearest up-left)

(assert (deep= [:direct "A1" 10]
               (formula-finder/resolve merged-mixed "A1"))
        "A1 direct, no formula up-left")

(assert (deep= [:formula "B3" "=1+1"]
               (formula-finder/resolve merged-mixed "B3"))
        "B3 has own formula")

(assert (deep= [:formula "B3" "=1+1"]
               (formula-finder/resolve merged-mixed "D5"))
        "D5 traced to B3 (nearest up-left formula)")

(assert (nil? (formula-finder/resolve merged-mixed "A2"))
        "A2 absent and no formula up-left → nil")

# ── multi-column spill: closer unrelated formula must not win ────
#
# Scenario from production (UNIT sheet, S20):
#   R4 carries a LET formula that returns a 4-column array
#     { col_R \ col_S \ col_T \ col_U }
#   so R4 is the home cell and S4 / T4 / U4 are spilled (no formula,
#   have values).  The same spill continues downward: S20, T20, U20
#   are all produced by R4.
#
#   Separately, I20 holds an unrelated formula.  I20 is closer to S20
#   by Manhattan distance (|20-20|+|19-9|=10) than R4 is (|20-4|+|19-18|=17),
#   so the current nearest-formula heuristic incorrectly picks I20.
#
#   The correct answer for find-source "S20" is R4: the formula whose
#   spill range covers column S.  We detect spill width from the data:
#   R4 has a formula and S4/T4/U4 in the same row are spilled
#   (value present, formula absent), giving an effective col-range R..U.
#
# These tests are RED until find-source is updated to use spill-width
# detection instead of raw Manhattan distance.

(def merged-multicol
  @[(range- @[
      # Row 4: R4 is formula home; S4 / T4 / U4 are spilled (no formula).
      @[(cell "R4" "vR" "=LET(a;1;{a\\a\\a\\a})")
        (cell "S4" "vS" "")
        (cell "T4" "vT" "")
        (cell "U4" "vU" "")]
      # Row 20: I20 is an unrelated formula; S20/T20/U20 are spilled from R4.
      @[(cell "I20" 0.15 "=UNRELATED(A1)")
        (cell "S20" "vS20" "")
        (cell "T20" "vT20" "")
        (cell "U20" "vU20" "")]])])

# Home cell: R4 resolves to itself.
(assert (deep= ["R4" "=LET(a;1;{a\\a\\a\\a})"]
               (formula-finder/find-source merged-multicol "R4"))
        "multi-col: R4 (home) resolves to itself")

# S4 is one column into the spill — must resolve to R4, not to something
# further left (there's nothing further left in this dataset).
(assert (deep= ["R4" "=LET(a;1;{a\\a\\a\\a})"]
               (formula-finder/find-source merged-multicol "S4"))
        "multi-col: S4 (spilled in same row) resolves to R4")

# S20 is the key failing case: I20 (Manhattan=10) beats R4 (Manhattan=17)
# under the current heuristic, but R4 is the correct source.
(assert (deep= ["R4" "=LET(a;1;{a\\a\\a\\a})"]
               (formula-finder/find-source merged-multicol "S20"))
        "multi-col: S20 resolves to R4, not closer I20")

# T20 is 2 columns into the spill — also covered by R4.
(assert (deep= ["R4" "=LET(a;1;{a\\a\\a\\a})"]
               (formula-finder/find-source merged-multicol "T20"))
        "multi-col: T20 (2 cols into spill) resolves to R4")

# U20 is the last column of the spill — must also resolve to R4.
(assert (deep= ["R4" "=LET(a;1;{a\\a\\a\\a})"]
               (formula-finder/find-source merged-multicol "U20"))
        "multi-col: U20 (last spill col) resolves to R4")

# Sanity: I20 itself must resolve to its own formula.
(assert (deep= ["I20" "=UNRELATED(A1)"]
               (formula-finder/find-source merged-multicol "I20"))
        "multi-col: I20 resolves to its own formula (not affected)")

# ── multi-column spill with competing formula in spill row ───────
#
# Edge case: a formula exists in the same row as the spill target but
# outside the spill band.  Formula at B2 writes 2 columns (B2, C2).
# Another formula exists at A4 (same col as B2, but below).
# D2 is one column past the spill → outside the band → should NOT
# resolve to B2 (and there's no qualifying formula for D2 at all).

(def merged-spilledge
  @[(range- @[
      # Row 2: B2 is formula home; C2 is spilled (no formula).
      @[(cell "B2" 10 "=LET(x;1;{x\\x})")
        (cell "C2" 10 "")]
      # Row 4: A4 is a formula below and to the left of C2.
      @[(cell "A4" 5 "=OTHER()")]])])

# C2 is within the 2-column spill of B2 → resolves to B2.
(assert (deep= ["B2" "=LET(x;1;{x\\x})"]
               (formula-finder/find-source merged-spilledge "C2"))
        "spill-edge: C2 (last spill col) resolves to B2")

# D2 is one column past the spill boundary → no qualifying formula.
(assert (nil? (formula-finder/find-source merged-spilledge "D2"))
        "spill-edge: D2 is outside spill, no formula → nil")

(print "formula-finder_test: all assertions passed")
