# Lookup tests — MATCH, CHOOSE, ROW, COLUMN, ROWS, COLUMNS, ADDRESS.
# Expected values from live Google Sheets.
#   mpu repl janet/tests/lookup2_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

# Minimal data so :ref evaluation works for ROW/COLUMN probes.
(def- merged
  @[(range- @[[(cell "A5" nil "")]
              [(cell "C1" nil "")]])])

(defn- ctx []
  @{:merged merged :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# MATCH — three match modes
(assert (= 3 (r "=MATCH(3,{1,2,3,4,5},0)"))   "MATCH exact")
(assert (= 3 (r "=MATCH(3,{1,2,3,4,5},1)"))   "MATCH ≤ (asc sorted)")
(assert (= 3 (r "=MATCH(3,{5,4,3,2,1},-1)"))  "MATCH ≥ (desc sorted)")

# CHOOSE
(assert (= "b" (r "=CHOOSE(2,\"a\",\"b\",\"c\")")) "CHOOSE 2")

# ROW / COLUMN on a :ref
(assert (= 5 (r "=ROW(A5)"))    "ROW A5 = 5")
(assert (= 3 (r "=COLUMN(C1)")) "COLUMN C1 = 3")

# ROWS / COLUMNS on array literals — semicolon for rows, backslash for cols
(assert (= 4 (r "=ROWS({1;2;3;4})"))    "ROWS vertical array")
(assert (= 4 (r "=COLUMNS({1\\2\\3\\4})")) "COLUMNS horizontal array")

# ADDRESS — 1=abs (default), 4=relative
(assert (= "$C$2" (r "=ADDRESS(2,3)"))    "ADDRESS default = absolute $C$2")
(assert (= "C2"   (r "=ADDRESS(2,3,4)"))  "ADDRESS 4 = relative C2")

(print "lookup2_test: all assertions passed")
