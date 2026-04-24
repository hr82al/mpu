# completion.janet — Tab-completion for the mpu REPL.
#
# complete/candidates is called by Go via EvalStringSlice on Tab press.
# Returns an array of full candidate strings.

(defn complete/mpu-names
  "Return a sorted array of all mpu/... command names."
  []
  (def raw (repl/commands))
  (if (or (nil? raw) (= raw ""))
    @[]
    (do
      (def result @[])
      (each line (string/split "\n" raw)
        (when (not= line "")
          (def parts (string/split "\t" line))
          (array/push result (string "mpu/" (get parts 0)))))
      (sort result))))

(defn complete/flag-names
  "Return an array of flag strings for a command (without mpu/ prefix)."
  [cmd-name]
  (def raw (repl/flags cmd-name))
  (if (or (nil? raw) (= raw ""))
    @[]
    (do
      (def result @[])
      (each line (string/split "\n" raw)
        (when (not= line "")
          (array/push result line)))
      result)))

(defn complete/keyword-flags
  "Return keyword-style flags (:opt-name) for a command."
  [cmd-name]
  (def flags (complete/flag-names cmd-name))
  (def result @[])
  (each f flags
    (when (string/has-prefix? "--" f)
      (array/push result (string ":" (string/slice f 2)))))
  result)

(defn complete/janet-symbols
  "Return an array of all Janet environment symbols."
  []
  (def result @[])
  (each k (keys (curenv))
    (when (symbol? k)
      (def s (string k))
      (when (not (string/has-prefix? "_" s))
        (array/push result s))))
  (sort result))

# ── Sexp parser: find the innermost unmatched '(' left of cursor ──

(defn- white? [c]
  (or (= c 32) (= c 9) (= c 10) (= c 13)))

(defn- white-or-paren? [c]
  (or (white? c)
      (= c 40) (= c 41)   # ( )
      (= c 91) (= c 93)   # [ ]
      (= c 123) (= c 125))) # { }

(defn- even-backslashes-before? [line i]
  # Count consecutive '\' chars immediately before position i.
  # A '"' is a real string boundary iff this count is even.
  (var count 0)
  (var j (- i 1))
  (while (and (>= j 0) (= (get line j) 92))
    (++ count)
    (-- j))
  (zero? (mod count 2)))

(defn complete/enclosing-call
  "Parse line right-to-left to find the innermost unmatched '('.
   Returns {:name \"foo\"} or nil."
  [line]
  (def max-scan 4096)
  (def n (length line))
  (def stop-i (max 0 (- n max-scan)))
  (var i (- n 1))
  (var depth 0)
  (var in-string false)
  (var found-open -1)
  (while (and (>= i stop-i) (< found-open 0))
    (def c (get line i))
    (cond
      in-string
        (when (and (= c 34) (even-backslashes-before? line i))
          (set in-string false))
      (= c 34)
        (set in-string true)
      (= c 41)
        (+= depth 1)
      (= c 40)
        (if (= depth 0)
          (set found-open i)
          (-= depth 1)))
    (-- i))
  (when (>= found-open 0)
    (def start (+ found-open 1))
    (var j start)
    (while (and (< j n) (not (white-or-paren? (get line j))))
      (++ j))
    (def name (string/slice line start j))
    (when (not= name "")
      {:name name})))

# ── Function parameter introspection ──

(defn- parse-sig-params [doc name]
  # Janet auto-prepends "(fn-name arg1 arg2 ...)\n\n" to :doc.
  (def first-line (get (string/split "\n" doc) 0))
  (when (and first-line (string/has-prefix? "(" first-line))
    (def without-open (string/slice first-line 1))
    (def close-idx (string/find ")" without-open))
    (def body (if close-idx (string/slice without-open 0 close-idx) without-open))
    (def parts (string/split " " body))
    (def out @[])
    (var saw-name false)
    (each p parts
      (cond
        (= p "") nil
        (not saw-name) (set saw-name true)
        (string/has-prefix? "&" p) nil
        (or (string/find "[" p) (string/find "]" p)
            (string/find "{" p) (string/find "}" p)) nil
        (array/push out p)))
    (if (empty? out) nil out)))

(defn complete/function-params
  "Return an array of parameter names for the function bound to `name`,
   or nil if unknown. Tries disasm first, falls back to docstring parsing."
  [name]
  (def sym (symbol name))
  (def info (try (dyn sym) ([_] nil)))
  (when info
    (def v (get info :value))
    (def from-disasm
      (when (function? v)
        (def d (try (disasm v) ([_] nil)))
        (when d
          (def arity (or (get d :max-arity) (get d :arity) 0))
          (def seen @{})
          (def out @[])
          (each entry (or (get d :symbolmap) [])
            (def slot (get entry 2))
            (def s (string (get entry 3)))
            (when (and (< slot arity)
                       (not= s name)
                       (not (string/has-prefix? "_" s))
                       (not (get seen s)))
              (put seen s true)
              (array/push out s)))
          (if (empty? out) nil out))))
    (if from-disasm
      from-disasm
      (do
        (def doc (get info :doc))
        (when (string? doc)
          (parse-sig-params doc name))))))

# ── Entry point ──

(defn complete/candidates
  "Return an array of full candidate strings matching prefix.
   Called by Go via EvalStringSlice on Tab press.
   `line` is the input text truncated to the cursor position."
  [line prefix]
  (def raw-ec (complete/enclosing-call line))
  # If the cursor is still inside the call's name (prefix == name), the user
  # is typing the function name itself — treat as if no enclosing call.
  (def ec (if (and raw-ec (= prefix (get raw-ec :name))) nil raw-ec))
  (def results @[])

  (cond
    # Keyword-flag completion: :sheet → :sheet-name
    (string/has-prefix? ":" prefix)
    (do
      (def nm (when ec (get ec :name)))
      (when (and nm (string/has-prefix? "mpu/" nm))
        (each kf (complete/keyword-flags (string/slice nm 4))
          (when (string/has-prefix? prefix kf)
            (array/push results kf))))
      (each sym (complete/janet-symbols)
        (when (and (string/has-prefix? ":" sym) (string/has-prefix? prefix sym))
          (array/push results sym))))

    # Inside a function call: offer args / keyword flags.
    ec
    (do
      (def nm (get ec :name))
      (cond
        (string/has-prefix? "mpu/" nm)
        (let [short (string/slice nm 4)]
          (each kf (complete/keyword-flags short)
            (when (or (= prefix "") (string/has-prefix? prefix kf))
              (array/push results kf)))
          (when (not= prefix "")
            (each sym (complete/janet-symbols)
              (when (string/has-prefix? prefix sym)
                (array/push results sym)))))
        (do
          (def params (or (complete/function-params nm) @[]))
          (each p params
            (when (or (= prefix "") (string/has-prefix? prefix p))
              (array/push results p)))
          (when (not= prefix "")
            (each sym (complete/janet-symbols)
              (when (string/has-prefix? prefix sym)
                (array/push results sym)))))))

    # Top level: mpu commands + janet symbols (only for non-empty prefix).
    (not= prefix "")
    (if (string/has-prefix? "mpu/" prefix)
      # Mpu-prefixed: only search mpu-names. Bridge fns are also in curenv,
      # so iterating both would produce duplicates and scan the whole env.
      (each name (complete/mpu-names)
        (when (string/has-prefix? prefix name)
          (array/push results name)))
      (do
        (each name (complete/mpu-names)
          (when (string/has-prefix? prefix name)
            (array/push results name)))
        (each sym (complete/janet-symbols)
          (when (string/has-prefix? prefix sym)
            (array/push results sym))))))

  results)
