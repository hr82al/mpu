# formula-parser.janet — spreadsheet formula → Janet AST.
#
# Loaded at VM boot via loadJanetScripts. Exposes pure functions; string
# I/O and cobra plumbing stay in the caller.
#
# AST node shapes (tagged tuples; easy to pattern-match and extend):
#   [:num n]              42, 3.14
#   [:str s]              "hello"
#   [:bool b]             TRUE / FALSE
#   [:ref "A1"]           cell reference
#   [:range "A1" "B2"]    range literal
#   [:name "Foo"]         bare identifier (named range etc.)
#   [:unop op x]          unary  op applied to x
#   [:binop op l r]       binary op applied to l r
#   [:call "FN" [args]]   function call
#
# SOLID:
#   * Single responsibility per layer: tokenizer → parser → AST.
#   * Open/closed: adding a binary operator is one line in *binops*.
#     Adding a new AST node adds one branch in parse-atom; old branches
#     are untouched.
#
# Extension recipe:
#   (put formula-parser/*binops* "%%" [3 false])   # new binop
#   (set formula-parser/*unary-ops* {"+" true "-" true "!" true})

# ── operator table ───────────────────────────────────────────────
(def formula-parser/*binops*
  "Binary operators as {op → [precedence right-assoc?]}. Mutable so a
   caller can register new operators without editing the parser body."
  @{"=" [1 false] "<>" [1 false] "<" [1 false] ">" [1 false]
    "<=" [1 false] ">=" [1 false]
    "&" [2 false]
    "+" [3 false] "-" [3 false]
    "*" [4 false] "/" [4 false]
    "^" [5 true]})

(def formula-parser/*unary-ops*
  "Set of operators usable in prefix position."
  @{"+" true "-" true})

(def- UNARY-PREC 6)

# ── character classes ────────────────────────────────────────────
(def- C-A (chr "A"))
(def- C-Z (chr "Z"))
(def- C-a (chr "a"))
(def- C-z (chr "z"))
(def- C-0 (chr "0"))
(def- C-9 (chr "9"))

(defn- upper? [c] (and c (>= c C-A) (<= c C-Z)))
(defn- lower? [c] (and c (>= c C-a) (<= c C-z)))
(defn- alpha? [c] (or (upper? c) (lower? c)))
(defn- digit? [c] (and c (>= c C-0) (<= c C-9)))
(defn- alnum? [c] (or (alpha? c) (digit? c)))
(def- C-_ (chr "_"))
(defn- ident-start? [c] (or (alpha? c) (= c C-_)))
(defn- ident-char?  [c] (or (alnum? c) (= c C-_)))

(defn- has-digit? [w]
  (def n (length w))
  (var j 0)
  (var found false)
  (while (and (not found) (< j n))
    (when (digit? (get w j)) (set found true))
    (++ j))
  found)
(defn- space? [c]
  (or (= c (chr " ")) (= c (chr "\t"))
      (= c (chr "\n")) (= c (chr "\r"))))

(defn- cell-word?
  "True iff w is [A-Z]+[0-9]+ — the A1 / AA100 shape."
  [w]
  (def n (length w))
  (var i 0)
  (while (and (< i n) (upper? (get w i))) (++ i))
  (cond
    (zero? i) false
    (= i n)   false
    (do
      (var j i)
      (while (and (< j n) (digit? (get w j))) (++ j))
      (= j n))))

# ── tokenizer ────────────────────────────────────────────────────
# Token shapes:
#   [:num n] [:str s] [:cell "A1"] [:range "A1" "B2"] [:ident "SUM"]
#   [:lparen] [:rparen] [:comma] [:op "+"]

(defn- num-end [s i]
  (var j i)
  (def n (length s))
  (while (and (< j n)
              (or (digit? (get s j)) (= (get s j) (chr "."))))
    (++ j))
  j)

(defn- word-end [s i]
  (var j i)
  (def n (length s))
  (while (and (< j n) (ident-char? (get s j))) (++ j))
  j)

(defn- read-ref-piece
  "Read one A1-style ref piece: $?[A-Z]+\\$?[0-9]* or $?[0-9]+.
   Preserves the $ markers in the returned string — the AST stores
   the piece verbatim. Returns [text end-index] or nil."
  [s i]
  (def n (length s))
  (var j i)
  (when (and (< j n) (= (get s j) (chr "$"))) (++ j))
  (def letters-start j)
  (while (and (< j n) (upper? (get s j))) (++ j))
  (def letters? (> j letters-start))
  (var dollar2 false)
  (when (and (< j n) (= (get s j) (chr "$")))
    (set dollar2 true)
    (++ j))
  (def digits-start j)
  (while (and (< j n) (digit? (get s j))) (++ j))
  (def digits? (> j digits-start))
  (cond
    (and (not letters?) (not digits?)) nil   # nothing matched
    (and dollar2 (not digits?))        nil   # dangling $ before no digits
    [(string/slice s i j) j]))

(defn- scan-op [s i]
  # Longest-match: try 2-char, then 1-char. Returns [op next-i] or nil.
  (def n (length s))
  (when (>= (- n i) 2)
    (def two (string/slice s i (+ i 2)))
    (when (or (= two "<=") (= two ">=") (= two "<>"))
      (break [two (+ i 2)])))
  (def c (get s i))
  (when (or (= c (chr "+")) (= c (chr "-"))
            (= c (chr "*")) (= c (chr "/"))
            (= c (chr "^")) (= c (chr "&"))
            (= c (chr "=")) (= c (chr "<"))
            (= c (chr ">")))
    [(string/from-bytes c) (+ i 1)]))

(defn- read-string-lit [s i]
  # Start at opening quote. Doubled "" → literal quote. Returns [val next-i].
  (def n (length s))
  (def buf @"")
  (var j (+ i 1))
  (var done false)
  (while (and (not done) (< j n))
    (def c (get s j))
    (cond
      (not= c (chr "\""))
      (do (buffer/push-byte buf c) (++ j))

      (and (< (+ j 1) n) (= (get s (+ j 1)) (chr "\"")))
      (do (buffer/push-byte buf c) (+= j 2))

      (do (set done true) (++ j))))
  (unless done (error "unterminated string literal"))
  [(string buf) j])

(defn formula-parser/tokenize
  "Split a formula string (no leading `=`) into tokens."
  [s]
  (def n (length s))
  (def out @[])
  (var i 0)
  (while (< i n)
    (def c (get s i))
    (cond
      (space? c) (++ i)

      (or (digit? c)
          (and (= c (chr "."))
               (< (+ i 1) n) (digit? (get s (+ i 1)))))
      (let [j (num-end s i)
            text (string/slice s i j)
            pure-int? (nil? (string/find "." text))
            piece2 (if (and pure-int?
                            (< j n) (= (get s j) (chr ":")))
                     (read-ref-piece s (+ j 1)))]
        (if piece2
          (let [[right k] piece2]
            (array/push out [:range text right])
            (set i k))
          (let [v (scan-number text)]
            (unless v (errorf "bad number at %d" i))
            (array/push out [:num v])
            (set i j))))

      (= c (chr "\""))
      (let [[val j] (read-string-lit s i)]
        (array/push out [:str val])
        (set i j))

      # quoted sheet name: '…'!ref [: ref]
      (= c (chr "'"))
      (let [close (do
                    (var k (+ i 1))
                    (while (and (< k n) (not= (get s k) (chr "'"))) (++ k))
                    (when (>= k n) (error "unterminated quoted sheet name"))
                    k)
            sheet-text (string/slice s i (+ close 1))
            bang (+ close 1)]
        (unless (and (< bang n) (= (get s bang) (chr "!")))
          (errorf "expected ! after quoted sheet %s" sheet-text))
        (let [piece (read-ref-piece s (+ bang 1))]
          (unless piece (errorf "invalid ref after %s!" sheet-text))
          (let [[text1 m] piece
                full1 (string sheet-text "!" text1)]
            (if (and (< m n) (= (get s m) (chr ":")))
              (let [p2 (read-ref-piece s (+ m 1))]
                (unless p2 (errorf "invalid range right of %s" full1))
                (let [[t2 p] p2]
                  (array/push out [:range full1 t2])
                  (set i p)))
              (do
                (array/push out [:cell full1])
                (set i m))))))

      (= c (chr "%"))
      (do (array/push out [:percent]) (++ i))

      # ─── ref-or-ident: uppercase, `$`, or lowercase/underscore ──
      # A1, $A$1, A$1, A:A, $1:$1, Sheet!$A$1, SUM, nm_id all come here.
      # Strategy: try read-ref-piece first; extend to a word if the
      # piece is immediately followed by ident-continuation chars;
      # then classify by the trailing context (`:`, `!`, neither).
      (or (upper? c) (lower? c) (= c C-_) (= c (chr "$")))
      (let [piece (read-ref-piece s i)
            piece-end (if piece (get piece 1) i)
            nxt (if (< piece-end n) (get s piece-end))
            piece-had-digit (and piece (has-digit? (get piece 0)))
            # Lowercase / underscore / (uppercase-after-digits) continue
            # the run — this was an identifier like BIN2DEC, not a cell.
            ident-cont? (or (lower? nxt) (= nxt C-_)
                            (and piece-had-digit (upper? nxt)))
            fallback-to-word (or (nil? piece) ident-cont?)]
        (if fallback-to-word
          (let [j (word-end s i)
                w (string/slice s i j)]
            (unless (pos? (length w))
              (errorf "invalid token at %d" i))
            (if (and (< j n) (= (get s j) (chr "!")))
              # word!ref [: ref]
              (let [piece-r (read-ref-piece s (+ j 1))]
                (unless piece-r (errorf "invalid ref after %s! at %d" w i))
                (let [[tr k] piece-r
                      full1 (string w "!" tr)]
                  (if (and (< k n) (= (get s k) (chr ":")))
                    (let [p2 (read-ref-piece s (+ k 1))]
                      (unless p2 (errorf "invalid range right of %s at %d" full1 i))
                      (let [[t2 m] p2]
                        (array/push out [:range full1 t2])
                        (set i m)))
                    (do
                      (array/push out [:cell full1])
                      (set i k)))))
              (do
                (array/push out [:ident w])
                (set i j))))
          (let [[text1 j] piece]
            (cond
              # range
              (and (< j n) (= (get s j) (chr ":")))
              (let [p2 (read-ref-piece s (+ j 1))]
                (unless p2 (errorf "invalid range right of %s at %d" text1 i))
                (let [[t2 k] p2]
                  (array/push out [:range text1 t2])
                  (set i k)))

              # function call: an A1-looking piece followed by `(` is
              # actually a function name (LOG10, BASE64, SHA256, …).
              (and (< j n) (= (get s j) (chr "(")))
              (do (array/push out [:ident text1]) (set i j))

              # sheet qualifier (piece is sheet name)
              (and (< j n) (= (get s j) (chr "!")))
              (let [p2 (read-ref-piece s (+ j 1))]
                (unless p2 (errorf "invalid ref after %s! at %d" text1 i))
                (let [[tr k] p2
                      full1 (string text1 "!" tr)]
                  (if (and (< k n) (= (get s k) (chr ":")))
                    (let [p3 (read-ref-piece s (+ k 1))]
                      (unless p3 (errorf "invalid range right of %s at %d" full1 i))
                      (let [[t3 m] p3]
                        (array/push out [:range full1 t3])
                        (set i m)))
                    (do
                      (array/push out [:cell full1])
                      (set i k)))))

              # function call / TRUE/FALSE / named range: letters-only piece
              # (no digits, no $) is an identifier.
              (and (nil? (string/find "$" text1))
                   (not (has-digit? text1)))
              (do
                (array/push out [:ident text1])
                (set i j))

              # plain cell
              (do
                (array/push out [:cell text1])
                (set i j))))))

      (= c (chr "(")) (do (array/push out [:lparen]) (++ i))
      (= c (chr ")")) (do (array/push out [:rparen]) (++ i))
      (= c (chr "{")) (do (array/push out [:lbrace]) (++ i))
      (= c (chr "}")) (do (array/push out [:rbrace]) (++ i))
      # `;` starts a new row inside `{…}` array literals (and also serves
      # as arg-separator in EU locale, handled in parse-args).
      (= c (chr ";"))
      (do (array/push out [:semicolon]) (++ i))
      (or (= c (chr ",")) (= c (chr "\\")))
      (do (array/push out [:comma]) (++ i))

      # fallback: operator
      (let [op (scan-op s i)]
        (if op
          (let [[sym j] op]
            (array/push out [:op sym])
            (set i j))
          (errorf "unexpected char %q at %d" (string/from-bytes c) i)))))
  out)

# ── parser ───────────────────────────────────────────────────────
# State is a table @{:toks [...] :pos n} — SRP: the state owns the
# cursor; parser functions take and return AST nodes.

(defn- peek-tok [st] (get (st :toks) (st :pos)))
(defn- advance-tok [st]
  (def t (peek-tok st))
  (put st :pos (+ 1 (st :pos)))
  t)

(var- parse-expr- nil)   # forward decl (mutual recursion)

(defn- expect [st tag]
  (def t (advance-tok st))
  (unless (and t (= (get t 0) tag))
    (errorf "expected %s, got %j" tag t))
  t)

(defn- slot-sep? [t]
  (and t (or (= (get t 0) :comma) (= (get t 0) :semicolon))))

(defn- parse-arg-slot [st]
  # Empty slot when the next token is a sep, rparen, or rbrace.
  (def t (peek-tok st))
  (if (and t (or (slot-sep? t)
                 (= (get t 0) :rparen) (= (get t 0) :rbrace)))
    [:empty]
    (parse-expr- st 0)))

(defn- parse-args [st]
  # Accepts `,` and `;` as arg-separators (EU-locale formulas use `;`).
  (def args @[])
  (def first (peek-tok st))
  (when (and first (not= (get first 0) :rparen))
    (array/push args (parse-arg-slot st))
    (while (slot-sep? (peek-tok st))
      (advance-tok st)
      (array/push args (parse-arg-slot st))))
  args)

(defn- parse-atom [st]
  (def t (advance-tok st))
  (unless t (error "unexpected end of input"))
  (def tag (get t 0))
  (cond
    (= tag :num)   [:num (get t 1)]
    (= tag :str)   [:str (get t 1)]
    (= tag :cell)  [:ref (get t 1)]
    (= tag :range) [:range (get t 1) (get t 2)]

    (= tag :ident)
    (let [w (get t 1)
          nxt (peek-tok st)]
      (cond
        (and nxt (= (get nxt 0) :lparen))
        (do
          (advance-tok st)
          (def args (parse-args st))
          (expect st :rparen)
          [:call w [;args]])
        (= w "TRUE")  [:bool true]
        (= w "FALSE") [:bool false]
        [:name w]))

    (= tag :lparen)
    (let [e (parse-expr- st 0)]
      (expect st :rparen)
      e)

    (= tag :lbrace)
    # Array literal. `,` / `\` separate columns, `;` separates rows.
    # If no `;` appears, return flat [:array …] for back-compat; else
    # emit [:matrix rows] preserving 2-D shape (ROWS/COLUMNS need it).
    (let [rows @[]]
      (var current @[])
      (var saw-row-sep false)
      (def nxt (peek-tok st))
      (when (and nxt (not= (get nxt 0) :rbrace))
        (array/push current (parse-arg-slot st))
        (var going true)
        (while going
          (def t (peek-tok st))
          (cond
            (nil? t) (set going false)
            (= (get t 0) :rbrace) (set going false)
            (= (get t 0) :comma)
            (do (advance-tok st) (array/push current (parse-arg-slot st)))
            (= (get t 0) :semicolon)
            (do (advance-tok st)
                (set saw-row-sep true)
                (array/push rows (tuple/slice current))
                (set current @[])
                (array/push current (parse-arg-slot st)))
            (set going false))))
      (when (not (empty? current)) (array/push rows (tuple/slice current)))
      (expect st :rbrace)
      (cond
        (empty? rows) [:array []]
        saw-row-sep  [:matrix [;rows]]
        [:array (get rows 0)]))

    (= tag :op)
    (let [op (get t 1)]
      (unless (get formula-parser/*unary-ops* op)
        (errorf "unexpected operator %s in prefix position" op))
      [:unop op (parse-expr- st UNARY-PREC)])

    (errorf "unexpected token: %j" t)))

(defn- wrap-postfix [st left]
  (var cur left)
  (while (let [t (peek-tok st)] (and t (= (get t 0) :percent)))
    (advance-tok st)
    (set cur [:postfix "%" cur]))
  cur)

(set parse-expr-
  (fn parse-expr [st min-prec]
    (var left (wrap-postfix st (parse-atom st)))
    (var running true)
    (while running
      (def t (peek-tok st))
      (def op (if (and t (= (get t 0) :op)) (get t 1)))
      (def entry (if op (get formula-parser/*binops* op)))
      (if (nil? entry)
        (set running false)
        (let [[prec right-assoc] entry]
          (if (< prec min-prec)
            (set running false)
            (do
              (advance-tok st)
              (def next-min (if right-assoc prec (+ prec 1)))
              (def right (wrap-postfix st (parse-expr st next-min)))
              (set left [:binop op left right]))))))
    left))

(defn formula-parser/parse
  "Parse a formula string (with or without leading `=`) into a Janet AST.
   See module comment for node shapes."
  [input]
  (def s (if (and (pos? (length input)) (= (get input 0) (chr "=")))
           (string/slice input 1)
           input))
  (def toks (formula-parser/tokenize s))
  (def st @{:toks toks :pos 0})
  (def ast (parse-expr- st 0))
  (when (peek-tok st)
    (errorf "unexpected trailing token: %j" (peek-tok st)))
  ast)
