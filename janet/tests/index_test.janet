# Tests for INDEX(reference, [row], [column]).
# Ref: https://support.google.com/docs/answer/3098242
#   mpu repl janet/tests/index_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

# A 2×3 block (A1:C2) = {1,2,3; 4,5,6} and a single-row range (E1:G1) for
# 1D-shortcut tests.
(def- merged
  @[(range- @[
      @[(cell "A1" 1 "") (cell "B1" 2 "") (cell "C1" 3 "")
        (cell "E1" 10 "") (cell "F1" 20 "") (cell "G1" 30 "")]
      @[(cell "A2" 4 "") (cell "B2" 5 "") (cell "C2" 6 "")]])])

(defn- ctx []
  @{:merged merged :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- run [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ── single-cell access ──────────────────────────────────────────
(assert (= 2 (run "=INDEX(A1:C2,1,2)"))   "(1,2) → B1=2")
(assert (= 6 (run "=INDEX(A1:C2,2,3)"))   "(2,3) → C2=6")

# ── whole row ───────────────────────────────────────────────────
(assert (deep= @[1 2 3] (run "=INDEX(A1:C2,1,0)"))
        "(1,0) → whole row 1")
(assert (deep= @[4 5 6] (run "=INDEX(A1:C2,2)"))
        "(2,omitted) → whole row 2")

# ── whole column ────────────────────────────────────────────────
(assert (deep= @[2 5] (run "=INDEX(A1:C2,0,2)"))
        "(0,2) → whole column 2")

# ── 1D-horizontal shortcut (single-row range) ────────────────────
(assert (= 20 (run "=INDEX(E1:G1,2)"))
        "single-row INDEX(arr,2) → 2nd element")

# ── empty/middle arg treated as 0 ───────────────────────────────
(assert (deep= @[2 5] (run "=INDEX(A1:C2,,2)"))
        "empty middle → whole column 2")

# ── errors ──────────────────────────────────────────────────────
(def err (protect (run "=INDEX()")))
(assert (not (get err 0)) "zero args errors")

(print "index_test: all assertions passed")
