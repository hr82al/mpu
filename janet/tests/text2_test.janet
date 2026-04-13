# Additional text functions — Sheets-validated.
#   mpu repl janet/tests/text2_test.janet

(defn- ctx []
  @{:merged @[] :sheet-name "UNIT" :addr "Z1"
    :sheet-cache @{} :missing-fns @{} :unresolved @[] :stub-dir nil})

(defn- r [f] (formula-eval/eval (formula-parser/parse f) (ctx)))

# T — returns "" for non-text, passthrough for text
(assert (= "" (r "=T(42)"))       "T on number → empty")
(assert (= "hi" (r "=T(\"hi\")")) "T on text → text")

# ARABIC / ROMAN round-trip
(assert (= 1990 (r "=ARABIC(\"MCMXC\")")) "ARABIC MCMXC")
(assert (= "MCMXC" (r "=ROMAN(1990)"))    "ROMAN 1990")

# Unicode
(assert (= 65 (r "=UNICODE(\"A\")"))  "UNICODE A = 65")
(assert (= "A" (r "=UNICHAR(65)"))    "UNICHAR 65 = A")

# CLEAN — strips non-printable control chars
(assert (= "hi" (r "=CLEAN(CHAR(9)&\"hi\")")) "CLEAN strips TAB")

# TEXTJOIN
(assert (= "a|b|c"
           (r "=TEXTJOIN(\"|\",TRUE,{\"a\",\"\",\"b\",\"c\"})"))
        "TEXTJOIN skips empty when ignore_empty=TRUE")

(print "text2_test: all assertions passed")
