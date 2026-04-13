# Tests for ISBLANK(value).
# Ref: https://support.google.com/docs/answer/3093290
#   mpu repl janet/tests/isblank_test.janet

(defn- cell [a v f] @{"a" a "v" v "f" f})
(defn- range- [cells] @{"range" "UNIT" "values" cells})

(def- merged
  @[(range- @[
      @[(cell "A1" 42   "")
        (cell "B1" ""   "")      # empty string
        (cell "C1" 0    "")
        (cell "D1" nil  "")]])]) # absent value

(defn- ctx []
  @{:merged merged :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- run [formula-str]
  (formula-eval/eval (formula-parser/parse formula-str) (ctx)))

(assert (= false (run "=ISBLANK(A1)"))       "42 is not blank")
(assert (= false (run "=ISBLANK(0)"))        "zero is not blank")
(assert (= false (run "=ISBLANK(\"x\")"))    "non-empty string not blank")
(assert (= true  (run "=ISBLANK(B1)"))       "empty string → blank")
(assert (= true  (run "=ISBLANK(D1)"))       "absent/nil → blank")
(assert (= true  (run "=ISBLANK(Z99)"))      "absent address → blank")

(def err (protect (run "=ISBLANK()")))
(assert (not (get err 0)) "zero args must error")

(print "isblank_test: all assertions passed")
