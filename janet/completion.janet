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

(defn- find-enclosing-mpu
  "Find the mpu/command name enclosing the cursor position in line."
  [line]
  (def idx (string/find-all "mpu/" line))
  (when (and idx (not (empty? idx)))
    (def last-idx (last idx))
    (def rest (string/slice line last-idx))
    (def end (or (string/find " " rest) (length rest)))
    (def name (string/slice rest 0 end))
    (when (string/has-prefix? "mpu/" name)
      (string/slice name 4))))

(defn complete/candidates
  "Return an array of full candidate strings matching prefix.
   Called by Go via EvalStringSlice on Tab press."
  [prefix]
  (def results @[])

  (cond
    # keyword-flag completion: :sheet → :sheet-name
    (string/has-prefix? ":" prefix)
    (do
      # try to find enclosing mpu command from repl/completion-context
      (def ctx (repl/completion-context))
      (when (and ctx (not= ctx ""))
        (each kf (complete/keyword-flags ctx)
          (when (string/has-prefix? prefix kf)
            (array/push results kf))))
      # also complete Janet keywords from environment
      (each sym (complete/janet-symbols)
        (when (and (string/has-prefix? ":" sym) (string/has-prefix? prefix sym))
          (array/push results sym))))

    # mpu command completion
    (string/has-prefix? "mpu/" prefix)
    (each name (complete/mpu-names)
      (when (string/has-prefix? prefix name)
        (array/push results name)))

    # general symbol / command completion
    (do
      (each name (complete/mpu-names)
        (when (string/has-prefix? prefix name)
          (array/push results name)))
      (each sym (complete/janet-symbols)
        (when (string/has-prefix? prefix sym)
          (array/push results sym)))))

  results)
