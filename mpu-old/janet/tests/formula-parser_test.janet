# Pure-logic tests for formula-parser. Runs inside an mpu VM; the library
# is loaded via loadJanetScripts so no explicit import is needed.
#
#   mpu repl janet/tests/formula-parser_test.janet
#
# Each (assert ...) raises on failure; `make test` exits non-zero.

# ── literals ──────────────────────────────────────────────────────

(assert (deep= [:num 42]     (formula-parser/parse "=42"))     "int")
(assert (deep= [:num 3.14]   (formula-parser/parse "=3.14"))   "float")
(assert (deep= [:str "hi"]   (formula-parser/parse "=\"hi\"")) "string")
(assert (deep= [:bool true]  (formula-parser/parse "=TRUE"))   "TRUE")
(assert (deep= [:bool false] (formula-parser/parse "=FALSE"))  "FALSE")

# Leading `=` is optional — the parser accepts raw expressions too.
(assert (deep= [:num 1] (formula-parser/parse "1")) "no leading =")

# ── references & ranges ──────────────────────────────────────────

(assert (deep= [:ref "A1"]        (formula-parser/parse "=A1"))    "cell ref")
(assert (deep= [:ref "AA100"]     (formula-parser/parse "=AA100")) "multi-letter ref")
(assert (deep= [:range "A1" "B2"] (formula-parser/parse "=A1:B2")) "range")
(assert (deep= [:range "R4" "T6"] (formula-parser/parse "=R4:T6")) "range R4:T6")

# ── unary / binary operators ─────────────────────────────────────

(assert (deep= [:unop "-" [:ref "A1"]]
               (formula-parser/parse "=-A1"))
        "unary minus")
(assert (deep= [:unop "+" [:num 7]]
               (formula-parser/parse "=+7"))
        "unary plus")
(assert (deep= [:binop "+" [:num 1] [:num 2]]
               (formula-parser/parse "=1+2"))
        "binary +")
(assert (deep= [:binop "+" [:num 1] [:binop "*" [:num 2] [:num 3]]]
               (formula-parser/parse "=1+2*3"))
        "* binds tighter than +")
(assert (deep= [:binop "*" [:binop "+" [:num 1] [:num 2]] [:num 3]]
               (formula-parser/parse "=(1+2)*3"))
        "parens override precedence")
(assert (deep= [:binop "^" [:num 2] [:binop "^" [:num 3] [:num 4]]]
               (formula-parser/parse "=2^3^4"))
        "^ right-associative")
(assert (deep= [:binop ">" [:ref "A1"] [:num 0]]
               (formula-parser/parse "=A1>0"))
        "> comparison")
(assert (deep= [:binop "<>" [:ref "A1"] [:num 0]]
               (formula-parser/parse "=A1<>0"))
        "<> two-char operator")
(assert (deep= [:binop "&" [:str "a"] [:str "b"]]
               (formula-parser/parse "=\"a\"&\"b\""))
        "string concat")

# ── function calls ───────────────────────────────────────────────

(assert (deep= [:call "NOW" []]
               (formula-parser/parse "=NOW()"))
        "zero-arg call")
(assert (deep= [:call "SUM" [[:range "A1" "B2"]]]
               (formula-parser/parse "=SUM(A1:B2)"))
        "one-arg call")
(assert (deep= [:call "IF" [[:binop ">" [:ref "A1"] [:num 0]]
                             [:str "pos"] [:str "neg"]]]
               (formula-parser/parse "=IF(A1>0,\"pos\",\"neg\")"))
        "IF with three args")
(assert (deep= [:call "MAX"
                 [[:num 1]
                  [:call "MIN" [[:num 2] [:num 3]]]]]
               (formula-parser/parse "=MAX(1,MIN(2,3))"))
        "nested calls")
(assert (deep= [:call "ARRAYFORMULA"
                 [[:binop "+" [:range "R4" "T6"] [:num 1]]]]
               (formula-parser/parse "=ARRAYFORMULA(R4:T6+1)"))
        "CLAUDE.md example")

# ── locale: `;` is an alias for `,` in EU-locale Sheets ──────────

(assert (deep= [:call "SUM" [[:num 1] [:num 2]]]
               (formula-parser/parse "=SUM(1;2)"))
        "`;` works as arg separator")
(assert (deep= [:call "IF" [[:binop ">" [:ref "A1"] [:num 0]]
                             [:str "p"] [:str "n"]]]
               (formula-parser/parse "=IF(A1>0;\"p\";\"n\")"))
        "`;` mixed with comparison")

# ── whitespace ───────────────────────────────────────────────────

(assert (deep= [:binop "+" [:num 1] [:num 2]]
               (formula-parser/parse "=  1  +  2  "))
        "whitespace tolerance")
(assert (deep= [:call "SUM" [[:num 1] [:num 2]]]
               (formula-parser/parse "= SUM( 1 , 2 )"))
        "whitespace inside call")

# ── named identifiers (not TRUE/FALSE and not cell refs) ─────────

(assert (deep= [:name "MyRange"]
               (formula-parser/parse "=MyRange"))
        "named identifier")
(assert (deep= [:name "nm_id"]
               (formula-parser/parse "=nm_id"))
        "identifier with underscore")
(assert (deep= [:name "_private"]
               (formula-parser/parse "=_private"))
        "identifier starting with underscore")
(assert (deep= [:call "LAMBDA" [[:name "nm_id"] [:name "nm_id"]]]
               (formula-parser/parse "=LAMBDA(nm_id, nm_id)"))
        "lambda param is underscore ident")

# ── absolute refs ($) and open (column/row-only) ranges ─────────

(assert (deep= [:ref "$A$1"] (formula-parser/parse "=$A$1"))  "abs $A$1")
(assert (deep= [:ref "$A1"]  (formula-parser/parse "=$A1"))   "abs-col $A1")
(assert (deep= [:ref "A$1"]  (formula-parser/parse "=A$1"))   "abs-row A$1")
(assert (deep= [:range "A" "A"]
               (formula-parser/parse "=A:A"))
        "column-only range")
(assert (deep= [:range "A1" "A"]
               (formula-parser/parse "=A1:A"))
        "mixed open column range")
(assert (deep= [:range "$A$4" "$F"]
               (formula-parser/parse "=$A$4:$F"))
        "abs col-only right side")
(assert (deep= [:range "1" "1"]
               (formula-parser/parse "=1:1"))
        "row-only range")
(assert (deep= [:range "$1" "$1"]
               (formula-parser/parse "=$1:$1"))
        "abs row-only range")

# ── sheet-qualified refs (Name!… stored as opaque string) ────────

(assert (deep= [:ref "Sheet1!A1"]
               (formula-parser/parse "=Sheet1!A1"))
        "sheet!cell")
(assert (deep= [:ref "today!$A$1"]
               (formula-parser/parse "=today!$A$1"))
        "lowercase sheet + abs ref")
(assert (deep= [:range "cards!$A$1" "$AD$1"]
               (formula-parser/parse "=cards!$A$1:$AD$1"))
        "sheet-qualified range")
(assert (deep= [:range "ce!$A$2" "$AK"]
               (formula-parser/parse "=ce!$A$2:$AK"))
        "sheet + open col range")
(assert (deep= [:range "ce!$1" "$1"]
               (formula-parser/parse "=ce!$1:$1"))
        "sheet + row-only range")

# ── empty (omitted) arguments ────────────────────────────────────
# Sheets lets you write `IF(cond; then; )` or `F(,x)` — empty slots are
# semantic "use default". Represent as [:empty].

(assert (deep= [:call "IF" [[:binop ">" [:ref "A1"] [:num 0]]
                             [:str "y"] [:empty]]]
               (formula-parser/parse "=IF(A1>0;\"y\";)"))
        "trailing empty arg")
(assert (deep= [:call "F" [[:empty] [:num 1]]]
               (formula-parser/parse "=F(,1)"))
        "leading empty arg")
(assert (deep= [:call "F" [[:num 1] [:empty] [:num 2]]]
               (formula-parser/parse "=F(1,,2)"))
        "middle empty arg")
(assert (deep= [:call "F" []]
               (formula-parser/parse "=F()"))
        "still no false positive on F()")

# ── array literal {…} — Sheets inline array ─────────────────────
# Column separator is `\` in `,`-locale (EU), `,` in `;`-locale (US).
# Rows use `;`. For AST simplicity, flatten — any of `,` `;` `\` end an element.

(assert (deep= [:array [[:num 1] [:num 2]]]
               (formula-parser/parse "={1,2}"))
        "flat array {1,2}")
(assert (deep= [:array [[:str ""]]]
               (formula-parser/parse "={\"\"}"))
        "single-element {\"\"}")
(assert (deep= [:array [[:str "a"] [:str "b"]]]
               (formula-parser/parse "={\"a\"\\\"b\"}"))
        "backslash column sep {\"a\"\\\"b\"}")
(assert (deep= [:array []]
               (formula-parser/parse "={}"))
        "empty array {}")
(assert (deep= [:call "IFERROR"
                 [[:ref "A1"]
                  [:array [[:str ""]]]]]
               (formula-parser/parse "=IFERROR(A1,{\"\"})"))
        "array inside call")

# ── quoted sheet names — 'Sheet With Spaces'!A1 ──────────────────

(assert (deep= [:ref "'My Sheet'!A1"]
               (formula-parser/parse "='My Sheet'!A1"))
        "quoted sheet + cell")
(assert (deep= [:range "'My Sheet'!A1" "B2"]
               (formula-parser/parse "='My Sheet'!A1:B2"))
        "quoted sheet + range")
(assert (deep= [:range "'ТарифыКороба'!$1" "$1"]
               (formula-parser/parse "='ТарифыКороба'!$1:$1"))
        "quoted cyrillic sheet + abs row range")

# ── percent postfix ───────────────────────────────────────────────
# 50% → [:postfix "%" [:num 50]]. Postfix binds tighter than binop.

(assert (deep= [:postfix "%" [:num 50]]
               (formula-parser/parse "=50%"))
        "percent after number")
(assert (deep= [:binop "+" [:num 1] [:postfix "%" [:ref "A1"]]]
               (formula-parser/parse "=1+A1%"))
        "percent after ref")

# ── extensibility: adding a binop is a one-line edit ─────────────
# Verify the table is the only place that decides the operator set.

(assert (get formula-parser/*binops* "+") "+ is registered")
(assert (get formula-parser/*binops* "^") "^ is registered")

(print "formula-parser_test: all assertions passed")
