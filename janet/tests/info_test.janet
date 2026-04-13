# Tests for Info functions (ISNUMBER ISTEXT ISERROR ISEVEN ISODD ISLOGICAL
# ISDATE N TYPE).
#   mpu repl janet/tests/info_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# ISNUMBER
(assert (= true  (r "=ISNUMBER(42)"))          "number")
(assert (= true  (r "=ISNUMBER(3.14)"))        "float")
(assert (= false (r "=ISNUMBER(\"42\")"))      "string not number")
(assert (= false (r "=ISNUMBER(TRUE)"))        "bool not number")

# ISTEXT
(assert (= true  (r "=ISTEXT(\"hi\")"))        "string → true")
(assert (= false (r "=ISTEXT(42)"))            "number not text")

# ISLOGICAL
(assert (= true  (r "=ISLOGICAL(TRUE)"))       "true is logical")
(assert (= true  (r "=ISLOGICAL(FALSE)"))      "false is logical")
(assert (= false (r "=ISLOGICAL(1)"))          "1 not logical")

# ISEVEN / ISODD
(assert (= true  (r "=ISEVEN(4)"))             "4 even")
(assert (= false (r "=ISEVEN(3)"))             "3 not even")
(assert (= true  (r "=ISODD(3)"))              "3 odd")
(assert (= false (r "=ISODD(4)"))              "4 not odd")

# ISERROR — in our evaluator :na keyword represents an error-like value
(assert (= true  (r "=ISERROR(NA())"))         "NA → true")
(assert (= false (r "=ISERROR(42)"))           "number → false")

# ISDATE — a date string is a minimal approximation; we accept YYYY-MM-DD
(assert (= true  (r "=ISDATE(\"2026-04-13\")")) "ISO date")
(assert (= false (r "=ISDATE(\"not a date\")")) "random string")

# N — convert to number
(assert (= 42  (r "=N(42)"))                   "passthrough number")
(assert (= 0   (r "=N(\"hi\")"))               "string → 0")
(assert (= 1   (r "=N(TRUE)"))                 "true → 1")
(assert (= 0   (r "=N(FALSE)"))                "false → 0")

# TYPE — 1 number, 2 text, 4 logical, 16 error, 64 array
(assert (= 1  (r "=TYPE(42)"))                 "number → 1")
(assert (= 2  (r "=TYPE(\"hi\")"))             "string → 2")
(assert (= 4  (r "=TYPE(TRUE)"))               "logical → 4")
(assert (= 16 (r "=TYPE(NA())"))               "error → 16")

(print "info_test: all assertions passed")
