# Array / HOF tests — values validated via Sheets with TEXTJOIN wrapper.
# "x|y|z" results are what Sheets returns when flattening & joining.
#   mpu repl janet/tests/array_hof_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ── FLATTEN / TRANSPOSE / TOROW / TOCOL ─────────────────────────
(assert (= "1|2|3|4" (r "=TEXTJOIN(\"|\",TRUE,FLATTEN({1\\2;3\\4}))"))
        "FLATTEN row-major")
(assert (= "1|2|3" (r "=TEXTJOIN(\"|\",TRUE,TRANSPOSE({1;2;3}))"))
        "TRANSPOSE column → row")
(assert (= "1|2|3" (r "=TEXTJOIN(\"|\",TRUE,TOROW({1;2;3}))"))
        "TOROW")
(assert (= "1|2|3" (r "=TEXTJOIN(\"|\",TRUE,TOCOL({1\\2\\3}))"))
        "TOCOL")

# ── CHOOSECOLS / CHOOSEROWS ─────────────────────────────────────
(assert (= "2|5" (r "=TEXTJOIN(\"|\",TRUE,CHOOSECOLS({1\\2\\3;4\\5\\6},2))"))
        "CHOOSECOLS pick col 2")
(assert (= "1|3|4|6"
           (r "=TEXTJOIN(\"|\",TRUE,CHOOSECOLS({1\\2\\3;4\\5\\6},1,3))"))
        "CHOOSECOLS cols 1 & 3")

# ── MAKEARRAY ───────────────────────────────────────────────────
(assert (= "11|12|21|22"
           (r "=TEXTJOIN(\"|\",TRUE,FLATTEN(MAKEARRAY(2,2,LAMBDA(r,c,r*10+c))))"))
        "MAKEARRAY 2x2")

# ── FILTER / SORT / UNIQUE / SORTN ─────────────────────────────
(assert (= "1|3|5"
           (r "=TEXTJOIN(\"|\",TRUE,FILTER({1;2;3;4;5},{TRUE;FALSE;TRUE;FALSE;TRUE}))"))
        "FILTER boolean mask")
(assert (= "1|2|3" (r "=TEXTJOIN(\"|\",TRUE,SORT({3;1;2}))"))
        "SORT ascending default")
(assert (= "3|2|1" (r "=TEXTJOIN(\"|\",TRUE,SORT({3;1;2},1,FALSE))"))
        "SORT descending")
(assert (= "1|2|3" (r "=TEXTJOIN(\"|\",TRUE,UNIQUE({1;1;2;2;3}))"))
        "UNIQUE")
(assert (= "1|2|3" (r "=TEXTJOIN(\"|\",TRUE,SORTN({5;3;1;4;2},3))"))
        "SORTN top-3")

# ── SEQUENCE ────────────────────────────────────────────────────
(assert (= "1|2|3"       (r "=TEXTJOIN(\"|\",TRUE,SEQUENCE(3))")) "SEQUENCE 3")
(assert (= "1|2|3|4|5|6" (r "=TEXTJOIN(\"|\",TRUE,FLATTEN(SEQUENCE(2,3)))"))
        "SEQUENCE 2x3")
(assert (= "10|15|20"
           (r "=TEXTJOIN(\"|\",TRUE,SEQUENCE(3,1,10,5))"))
        "SEQUENCE start=10 step=5")

# ── HSTACK / VSTACK ─────────────────────────────────────────────
# NOTE Sheets row-major flatten of HSTACK is 1|3|2|4 (column-stacked).
(assert (= "1|3|2|4"
           (r "=TEXTJOIN(\"|\",TRUE,FLATTEN(HSTACK({1;2},{3;4})))"))
        "HSTACK side-by-side → [[1,3],[2,4]]")
(assert (= "1|2|3|4"
           (r "=TEXTJOIN(\"|\",TRUE,FLATTEN(VSTACK({1\\2},{3\\4})))"))
        "VSTACK stacks rows")

# ── BYCOL / BYROW / SCAN ────────────────────────────────────────
(assert (= "4|6" (r "=TEXTJOIN(\"|\",TRUE,BYCOL({1\\2;3\\4},LAMBDA(c,SUM(c))))"))
        "BYCOL sums cols → 4|6")
(assert (= "3|7" (r "=TEXTJOIN(\"|\",TRUE,BYROW({1\\2;3\\4},LAMBDA(rw,SUM(rw))))"))
        "BYROW sums rows → 3|7")
(assert (= "1|3|6|10"
           (r "=TEXTJOIN(\"|\",TRUE,SCAN(0,{1;2;3;4},LAMBDA(a,b,a+b)))"))
        "SCAN running sum")

# ── REDUCE ─────────────────────────────────────────────────────
(assert (= 10 (r "=REDUCE(0,{1;2;3;4},LAMBDA(a,b,a+b))"))
        "REDUCE sum")

# ── XLOOKUP / INDEX ────────────────────────────────────────────
(assert (= "c" (r "=XLOOKUP(3,{1;2;3;4;5},{\"a\";\"b\";\"c\";\"d\";\"e\"})"))
        "XLOOKUP 1D hit")
(assert (= "none" (r "=XLOOKUP(99,{1;2;3},{\"a\";\"b\";\"c\"},\"none\")"))
        "XLOOKUP miss → fallback")

(assert (= 6 (r "=INDEX({1\\2\\3;4\\5\\6},2,3)")) "INDEX 2D (2,3) = 6")

# ── WRAPROWS / WRAPCOLS ────────────────────────────────────────
(assert (= "1|2|3|4|5|6"
           (r "=TEXTJOIN(\"|\",TRUE,FLATTEN(WRAPROWS({1;2;3;4;5;6},2)))"))
        "WRAPROWS 6→3×2")
(assert (= "1|3|5|2|4|6"
           (r "=TEXTJOIN(\"|\",TRUE,FLATTEN(WRAPCOLS({1;2;3;4;5;6},2)))"))
        "WRAPCOLS 6→2×3 (column-major flat)")

(print "array_hof_test: all assertions passed")
