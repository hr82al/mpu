# Tests for logical functions (AND OR NOT XOR IFS SWITCH IFNA TRUE FALSE).
# Ref: https://support.google.com/docs/table/25273 (logical section)
#   mpu repl janet/tests/logical_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ── AND ──────────────────────────────────────────────────────────
(assert (= true  (r "=AND(TRUE, TRUE)"))          "AND all true")
(assert (= false (r "=AND(TRUE, FALSE)"))         "AND with false")
(assert (= true  (r "=AND(1, 2, 3)"))             "AND non-zero numbers")
(assert (= false (r "=AND(1, 0, 1)"))             "AND contains 0")

# ── OR ───────────────────────────────────────────────────────────
(assert (= true  (r "=OR(FALSE, TRUE)"))          "OR one true")
(assert (= false (r "=OR(FALSE, FALSE)"))         "OR all false")
(assert (= true  (r "=OR(0, 0, 1)"))              "OR numeric truthy")

# ── NOT ──────────────────────────────────────────────────────────
(assert (= false (r "=NOT(TRUE)"))                "NOT true → false")
(assert (= true  (r "=NOT(FALSE)"))               "NOT false → true")
(assert (= true  (r "=NOT(0)"))                   "NOT 0 → true")
(assert (= false (r "=NOT(5)"))                   "NOT 5 → false")

# ── XOR ──────────────────────────────────────────────────────────
(assert (= true  (r "=XOR(TRUE, FALSE)"))         "XOR 1 true")
(assert (= false (r "=XOR(TRUE, TRUE)"))          "XOR 2 true → false")
(assert (= true  (r "=XOR(TRUE, TRUE, TRUE)"))    "XOR 3 true → true")
(assert (= false (r "=XOR(FALSE, FALSE)"))        "XOR all false → false")

# ── TRUE / FALSE as nullary ─────────────────────────────────────
(assert (= true  (r "=TRUE()"))                   "TRUE()")
(assert (= false (r "=FALSE()"))                  "FALSE()")

# ── SWITCH ───────────────────────────────────────────────────────
(assert (= "a" (r "=SWITCH(1, 1, \"a\", 2, \"b\")")) "match case 1")
(assert (= "b" (r "=SWITCH(2, 1, \"a\", 2, \"b\")")) "match case 2")
(assert (= "x" (r "=SWITCH(9, 1, \"a\", 2, \"b\", \"x\")")) "default")
(def e-switch (protect (r "=SWITCH(9, 1, \"a\", 2, \"b\")")))
(assert (not (get e-switch 0)) "no match + no default errors")

# ── IFS ──────────────────────────────────────────────────────────
(assert (= "pos" (r "=IFS(5>0, \"pos\", 5<0, \"neg\")")) "first match")
(assert (= "neg" (r "=IFS(5<0, \"pos\", 5<10, \"neg\")")) "second match")
(def e-ifs (protect (r "=IFS(5<0, \"a\", 5<3, \"b\")")))
(assert (not (get e-ifs 0)) "no matching condition errors")

# ── IFNA ─────────────────────────────────────────────────────────
(assert (= 42    (r "=IFNA(42, \"fb\")"))         "non-NA value passthrough")
(assert (= "fb"  (r "=IFNA(NA(), \"fb\")"))       "NA → fallback")

(print "logical_test: all assertions passed")
