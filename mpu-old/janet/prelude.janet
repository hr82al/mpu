# prelude.janet — IPython-like magic commands and utilities.

# ── Result / input history ────────────────────────────────────────
(var _    nil)
(var __   nil)
(var ___  nil)
(var _i   nil)
(var _ii  nil)
(var _iii nil)

# ── Execution counter ─────────────────────────────────────────────
(var *counter* 0)

# ── Magic commands ────────────────────────────────────────────────

(defn %time
  "Time the evaluation of a Janet expression string.
   Usage: (%time \"(+ 1 2)\") or (%time \"(mpu/clients)\")"
  [code-str]
  (def start (os/clock))
  (def result (eval-string code-str))
  (def elapsed (- (os/clock) start))
  (printf "%s%.4fs%s" (c :nil) elapsed (cr))
  result)

(defn %who
  "List user-defined bindings in the current environment."
  []
  (def env (curenv))
  (def names @[])
  (each k (keys env)
    (when (symbol? k)
      (def s (string k))
      (when (and (not (string/has-prefix? "_" s))
                 (not (string/has-prefix? "%" s))
                 (not (string/has-prefix? "ansi/" s))
                 (not (string/has-prefix? "color/" s))
                 (not (string/has-prefix? "highlight/" s))
                 (not (string/has-prefix? "complete/" s))
                 (not (string/has-prefix? "prompt/" s))
                 (not (string/has-prefix? "repl/" s))
                 (not (string/has-prefix? "mpu/" s))
                 (not (string/has-prefix? "theme/" s))
                 (not (string/has-prefix? "*" s)))
        (array/push names s))))
  (sort names)
  (if (empty? names)
    (print (paint :nil "  (no user bindings)"))
    (each n names
      (def val (get env (symbol n)))
      (def vstr (string/format "%.60q" (get val :value val)))
      (print (string "  " (paint :builtin n)
                     (paint :nil (string " = " vstr)))))))

(defn %hist
  "Show recent input history."
  [&opt n]
  (default n 20)
  (def raw (repl/history (string n)))
  (when (and raw (not= raw ""))
    (var i 1)
    (each line (string/split "\n" raw)
      (when (not= line "")
        (printf "%s%3d%s  %s" (c :nil) i (cr) line)
        (++ i)))))

(defn %hist-search
  "Search input history for a pattern."
  [pattern]
  (def raw (repl/history "1000"))
  (when (and raw (not= raw ""))
    (def pat (string/ascii-lower pattern))
    (var i 1)
    (each line (string/split "\n" raw)
      (when (not= line "")
        (when (string/find pat (string/ascii-lower line))
          (printf "%s%3d%s  %s" (c :nil) i (cr) line))
        (++ i)))))

(defn %env
  "Show REPL environment info."
  []
  (print)
  (print (string (c :bold) "  REPL Environment" (cr)))
  (print (string "  Janet version : " (paint :num (string janet/version))))
  (print (string "  Build         : " (paint :num (string janet/build))))
  (print (string "  Janet dir     : " (paint :str (repl/janet-dir))))
  (print (string "  History file  : " (paint :str (repl/history-file))))
  (print (string "  Counter       : " (paint :num (string *counter*))))
  (print))

(defn %load
  "Load and evaluate a Janet file."
  [path]
  (def src (slurp path))
  (eval-string src))

(defn %pp
  "Pretty-print a value with syntax highlighting."
  [val]
  (def s (string/format "%q" val))
  (print (highlight/source s)))

(defn %highlight
  "Display Janet source with syntax highlighting."
  [src]
  (print (highlight/source src)))

(defn %reset
  "Reset the REPL state (clear result history and counter)."
  []
  (set _ nil) (set __ nil) (set ___ nil)
  (set _i nil) (set _ii nil) (set _iii nil)
  (set *counter* 0)
  (print (paint :nil "  REPL state reset.")))

(defn p
  "Shortcut: pretty-print any value."
  [& args]
  (each a args
    (print (string/format "%q" a))))
