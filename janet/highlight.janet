# highlight.janet — Theme-based syntax highlighting for the mpu REPL.
#
# Design: DRY named color roles + pluggable theme table.
# Default theme uses 256-color ANSI for good contrast on dark terminals.
# Override with (set-theme my-theme) in rc.janet.

# ── Theme system ──────────────────────────────────────────────────

(def theme/default
  "Default dark-terminal color theme."
  @{:reset   "\e[0m"
    :bold    "\e[1m"
    :dim     "\e[2m"
    :italic  "\e[3m"
    # Semantic roles
    :num     "\e[34m"         # numbers — blue
    :str     "\e[32m"         # strings — green
    :kw      "\e[35m"         # keywords (:foo) — magenta
    :bool    "\e[36m"         # true/false — cyan
    :nil     "\e[90m"         # nil — gray
    :sym     "\e[0m"          # plain symbols — default
    :special "\e[1;36m"       # special forms (def, fn, if) — bold cyan
    :macro   "\e[1;33m"       # macros (defn, each, loop) — bold yellow
    :builtin "\e[33m"         # built-in functions — yellow
    :mpu     "\e[38;5;214m"   # mpu/ commands — orange
    :opt     "\e[38;5;109m"   # options/flags (:opt) — teal
    :comment "\e[90m"         # comments — gray
    :paren   "\e[90m"         # delimiters ()[]{}— gray
    :fn      "\e[90m"         # <function> display — gray
    :mut     "\e[33m"         # mutable collections @[] @{} — yellow
    :buf     "\e[32m"         # buffers @"" — green
    :err     "\e[31m"         # errors — red
    :prompt  "\e[1;36m"       # prompt accent — bold cyan
    :counter "\e[33m"})       # prompt counter — yellow

(def theme/light
  "Light-terminal color theme."
  @{:reset   "\e[0m"
    :bold    "\e[1m"
    :dim     "\e[2m"
    :italic  "\e[3m"
    :num     "\e[34m"
    :str     "\e[32m"
    :kw      "\e[35m"
    :bool    "\e[36m"
    :nil     "\e[90m"
    :sym     "\e[0m"
    :special "\e[1;34m"
    :macro   "\e[1;35m"
    :builtin "\e[35m"
    :mpu     "\e[1;33m"
    :opt     "\e[36m"
    :comment "\e[37m"
    :paren   "\e[37m"
    :fn      "\e[37m"
    :mut     "\e[35m"
    :buf     "\e[32m"
    :err     "\e[31m"
    :prompt  "\e[1;34m"
    :counter "\e[35m"})

(var *theme* theme/default)

(defn set-theme
  "Set the active color theme table."
  [t]
  (set *theme* t))

(defn- c
  "Get color code for role from current theme."
  [role]
  (get *theme* role ""))

(defn- cr [] (c :reset))

(defn- paint
  "Wrap string s in the color for role."
  [role s]
  (string (c role) s (cr)))

# ── Color helpers (public) ────────────────────────────────────────

(defn color/red     [s] (string "\e[31m" s (cr)))
(defn color/green   [s] (paint :str s))
(defn color/yellow  [s] (paint :builtin s))
(defn color/blue    [s] (paint :num s))
(defn color/magenta [s] (paint :kw s))
(defn color/cyan    [s] (paint :bool s))
(defn color/gray    [s] (paint :nil s))
(defn color/bold    [s] (string (c :bold) s (cr)))

# ── Value highlighting (for REPL output) ──────────────────────────

(defn highlight/value
  "Colorize a Janet value representation string."
  [s]
  (cond
    (or (= s "nil") (= s ""))   (paint :nil "nil")
    (string/has-prefix? "\"" s)  (paint :str s)
    (string/has-prefix? ":" s)   (paint :kw s)
    (or (= s "true") (= s "false")) (paint :bool s)
    (not (nil? (scan-number s))) (paint :num s)
    (string/has-prefix? "@\"" s) (paint :buf s)
    (string/has-prefix? "@" s)   (paint :mut s)
    (string/has-prefix? "<" s)   (paint :fn s)
    s))

# ── Type-aware result highlighting (from Go DoEval) ──────────────
# Type codes: 0=num 1=nil 2=bool 4=str 5=sym 6=kw
#   7=array 8=tuple 9=table 10=struct 11=buf 12=fn 13=cfn

(defn highlight/result
  "Colorize a REPL result using Janet type code from Go."
  [type-code str-repr]
  (case type-code
    0  (paint :num str-repr)
    1  (paint :nil "nil")
    2  (paint :bool str-repr)
    4  (paint :str (string "\"" str-repr "\""))
    5  (paint :sym str-repr)
    6  (paint :kw (string ":" str-repr))
    7  (paint :mut str-repr)
    8  (paint :builtin str-repr)
    9  (paint :mut str-repr)
    10 (paint :builtin str-repr)
    11 (paint :buf str-repr)
    12 (paint :fn str-repr)
    13 (paint :fn str-repr)
    str-repr))

# ── Source code highlighting ──────────────────────────────────────

(def- janet-specials
  {"def" true "var" true "fn" true "do" true "quote" true "if" true
   "splice" true "while" true "break" true "set" true
   "quasiquote" true "unquote" true "upscope" true})

(def- janet-macros
  {"defn" true "defn-" true "defmacro" true "defmacro-" true
   "let" true "cond" true "case" true "when" true "unless" true
   "match" true "each" true "loop" true "for" true "seq" true
   "generate" true "try" true "catch" true "finally" true
   "with" true "defer" true "coro" true "import" true "use" true
   "require" true "default" true "if-let" true "when-let" true
   "if-not" true "if-with" true "with-dyns" true})

(defn highlight/token
  "Colorize a single token string."
  [tok]
  (cond
    (string/has-prefix? "#" tok)    (paint :comment tok)
    (string/has-prefix? "\"" tok)   (paint :str tok)
    (string/has-prefix? ":" tok)    (paint :kw tok)
    (or (= tok "true") (= tok "false") (= tok "nil"))
                                    (paint :bool tok)
    (not (nil? (scan-number tok)))  (paint :num tok)
    (get janet-specials tok)        (paint :special tok)
    (get janet-macros tok)          (paint :macro tok)
    (string/has-prefix? "mpu/" tok) (paint :mpu tok)
    tok))

(defn highlight/source
  "Colorize Janet source code (best-effort tokenization)."
  [src]
  (def buf @"")
  (var i 0)
  (def n (length src))
  (while (< i n)
    (def ch (get src i))
    (cond
      # whitespace
      (or (= ch (chr " ")) (= ch (chr "\t")) (= ch (chr "\n")) (= ch (chr "\r")))
      (do (buffer/push buf ch) (++ i))

      # comment
      (= ch (chr "#"))
      (do
        (var j i)
        (while (and (< j n) (not= (get src j) (chr "\n"))) (++ j))
        (buffer/push buf (c :comment))
        (buffer/push buf (string/slice src i j))
        (buffer/push buf (cr))
        (set i j))

      # string literal
      (= ch (chr "\""))
      (do
        (var j (+ i 1))
        (while (< j n)
          (if (= (get src j) (chr "\\"))
            (+= j 2)
            (if (= (get src j) (chr "\""))
              (do (++ j) (break))
              (++ j))))
        (buffer/push buf (c :str))
        (buffer/push buf (string/slice src i j))
        (buffer/push buf (cr))
        (set i j))

      # delimiters
      (or (= ch (chr "(")) (= ch (chr ")"))
          (= ch (chr "[")) (= ch (chr "]"))
          (= ch (chr "{")) (= ch (chr "}")))
      (do
        (buffer/push buf (c :paren))
        (buffer/push buf ch)
        (buffer/push buf (cr))
        (++ i))

      # quote-like prefixes
      (or (= ch (chr "'")) (= ch (chr "~")) (= ch (chr ";")) (= ch (chr ",")))
      (do
        (buffer/push buf (c :paren))
        (buffer/push buf ch)
        (buffer/push buf (cr))
        (++ i))

      # word token
      (do
        (var j i)
        (while (and (< j n)
                    (let [x (get src j)]
                      (not (or (= x (chr " ")) (= x (chr "\t"))
                               (= x (chr "\n")) (= x (chr "\r"))
                               (= x (chr "(")) (= x (chr ")"))
                               (= x (chr "[")) (= x (chr "]"))
                               (= x (chr "{")) (= x (chr "}"))
                               (= x (chr "\""))))))
          (++ j))
        (def tok (string/slice src i j))
        (buffer/push buf (highlight/token tok))
        (set i j))))
  (string buf))
