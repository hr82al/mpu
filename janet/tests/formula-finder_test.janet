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

(print "formula-finder_test: all assertions passed")
