# Pure-logic tests for the ss-analyze library. Runs inside an mpu VM so the
# library is loaded via loadJanetScripts — no separate import needed.
#
# Usage (via Makefile target):
#   mpu repl janet/tests/ss-analyze_test.janet
#
# Any (assert ...) failure raises a Janet error; script mode returns that
# error and the process exits non-zero, so `make test` fails loudly.

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT!A1:ZZZ" "values" cells})

# ── cell->rc ──────────────────────────────────────────────────────

(assert (deep= [1  1]  (ss-analyze/cell->rc "A1"))   "A1  → [1 1]")
(assert (deep= [6  20] (ss-analyze/cell->rc "T6"))   "T6  → [6 20]")
(assert (deep= [4  18] (ss-analyze/cell->rc "R4"))   "R4  → [4 18]")
(assert (deep= [100 27] (ss-analyze/cell->rc "AA100")) "AA100 → [100 27]")

# ── find-source: target is a spilled cell, source is up-left ─────
# This is the CLAUDE.md example — UNIT sheet, T6 ← R4.

(def merged-spill
  @[(range- @[
      @[(cell "R4" 42  "=ARRAYFORMULA(R4:T6 + 1)")]
      @[(cell "T6" "x" "")]])])

(assert (deep= ["R4" "=ARRAYFORMULA(R4:T6 + 1)"]
               (ss-analyze/find-source merged-spill "T6"))
        "spilled T6 must resolve to [R4 formula]")

# ── find-source: target itself carries the formula ───────────────

(def merged-self
  @[(range- @[@[(cell "B2" 99 "=SUM(A1:A2)")]])])

(assert (deep= ["B2" "=SUM(A1:A2)"]
               (ss-analyze/find-source merged-self "B2"))
        "B2 with its own formula must return [B2 formula]")

# ── find-source: no qualifying formula → nil ─────────────────────

(def merged-empty
  @[(range- @[@[(cell "A1" 1 "") (cell "B1" 2 "") (cell "C1" 3 "")]])])

(assert (nil? (ss-analyze/find-source merged-empty "C3"))
        "no formula above-left of C3 → nil")

# ── find-source: formula to the right must NOT match ─────────────
# Spilled arrays only flow right/down, so a formula at Z1 cannot feed A5.

(def merged-right
  @[(range- @[
      @[(cell "Z1" 7  "=ARRAYFORMULA(Z1:Z9)")]
      @[(cell "A5" "v" "")]])])

(assert (nil? (ss-analyze/find-source merged-right "A5"))
        "formula right of target must be ignored")

# ── find-source: closer candidate beats farther one ──────────────

(def merged-two
  @[(range- @[
      @[(cell "A1" "x" "=FAR()")]
      @[(cell "R4" "y" "=NEAR()")]
      @[(cell "T6" "v" "")]])])

(assert (deep= ["R4" "=NEAR()"] (ss-analyze/find-source merged-two "T6"))
        "closer formula R4 must win over distant A1")

(print "ss-analyze_test: all assertions passed")
