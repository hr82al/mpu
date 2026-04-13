# Tests for text functions.
#   mpu repl janet/tests/text_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# LEN / UPPER / LOWER / PROPER / TRIM
(assert (= 5 (r "=LEN(\"hello\")"))                 "LEN")
(assert (= "HELLO" (r "=UPPER(\"hello\")"))         "UPPER")
(assert (= "hello" (r "=LOWER(\"HELLO\")"))         "LOWER")
(assert (= "Hello World" (r "=PROPER(\"hello world\")")) "PROPER")
(assert (= "hi" (r "=TRIM(\"   hi   \")"))          "TRIM leading/trailing")

# LEFT / RIGHT / MID (1-based)
(assert (= "ab"  (r "=LEFT(\"abcde\", 2)"))         "LEFT 2")
(assert (= "a"   (r "=LEFT(\"abcde\")"))            "LEFT default=1")
(assert (= "de"  (r "=RIGHT(\"abcde\", 2)"))        "RIGHT 2")
(assert (= "e"   (r "=RIGHT(\"abcde\")"))           "RIGHT default=1")
(assert (= "bcd" (r "=MID(\"abcde\", 2, 3)"))       "MID 2..3 chars")

# CHAR / CODE
(assert (= "A" (r "=CHAR(65)"))                     "CHAR 65")
(assert (= 65  (r "=CODE(\"A\")"))                  "CODE A")

# REPT
(assert (= "xxx" (r "=REPT(\"x\", 3)"))             "REPT")

# EXACT / VALUE
(assert (= true  (r "=EXACT(\"abc\", \"abc\")"))    "EXACT equal")
(assert (= false (r "=EXACT(\"abc\", \"ABC\")"))    "EXACT case-sensitive")
(assert (= 42    (r "=VALUE(\"42\")"))              "VALUE parse")
(assert (= 3.14  (r "=VALUE(\"3.14\")"))            "VALUE float")

# CONCAT / JOIN (CONCATENATE already covered elsewhere)
(assert (= "ab"    (r "=CONCAT(\"a\", \"b\")"))     "CONCAT")
(assert (= "a,b,c" (r "=JOIN(\",\", \"a\", \"b\", \"c\")")) "JOIN")

# FIND / SEARCH (1-based; FIND case-sensitive; SEARCH not)
(assert (= 2 (r "=FIND(\"bc\", \"abcd\")"))         "FIND")
(assert (= 2 (r "=SEARCH(\"BC\", \"abcd\")"))       "SEARCH case-insensitive")

# SUBSTITUTE / REPLACE
(assert (= "axxd" (r "=SUBSTITUTE(\"abbd\", \"bb\", \"xx\")"))
        "SUBSTITUTE")
(assert (= "aZZd" (r "=REPLACE(\"abcd\", 2, 2, \"ZZ\")"))
        "REPLACE start=2, len=2")

# TEXT — minimal format handling (plain passthrough tokens like yyyy-MM-dd
# via strftime-style; we delegate via os/date when given a number).
(assert (= "hello" (r "=TEXT(\"hello\", \"@\")"))
        "TEXT passthrough string")
(assert (= "42"    (r "=TEXT(42, \"@\")"))
        "TEXT number → string")

# SPLIT
(assert (deep= @["a" "b" "c"] (r "=SPLIT(\"a,b,c\", \",\")"))
        "SPLIT comma")

# REGEX family
(assert (= "a_b" (r "=REGEXREPLACE(\"a b\", \" \", \"_\")"))
        "REGEXREPLACE space → underscore")
(assert (= true  (r "=REGEXMATCH(\"abc123\", \"\\d+\")"))
        "REGEXMATCH finds digits")
(assert (= "123" (r "=REGEXEXTRACT(\"abc123def\", \"\\d+\")"))
        "REGEXEXTRACT extracts digits")

(print "text_test: all assertions passed")
