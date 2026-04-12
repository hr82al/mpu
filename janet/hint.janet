# hint.janet — inline help text for REPL symbols.
#
# (hint/for name)     → multi-line string (up to *hint-max-lines* lines)
# (hint/register ...) → add or override a custom example
#
# Lookup order:
#   1. *hint-examples* (custom, curated — has examples, short description)
#   2. cobra Short/Long for mpu/* commands (via repl/doc bridge)
#   3. docstring of the Janet binding (via dyn)
#
# Empty string means "no hint available" — the REPL shows nothing.

(var *hint-max-lines* 10)

# ── Custom registry ──────────────────────────────────────────────────────

(def *hint-examples*
  "Curated examples: map from full name → array of display lines.
   Overrides docstrings so we can show idiomatic usage in under ~5 lines."
  @{
    # ── mpu commands ───────────────────────────────────────────────
    "mpu/get"
    @["Get items from a spreadsheet tab"
      "(mpu/get :s \"SHEET_ID\" :n \"Sheet1\")"
      "(mpu/get 54 :n \"UNIT\")      # by client id"
      "(mpu/get \"Cool\" :n \"UNIT\")   # fuzzy title search"]

    "mpu/set"
    @["Replace sheet data with a JSON array of objects"
      "(mpu/set :s \"SHEET_ID\" :n \"Sheet1\" \"[{\\\"id\\\":1}]\")"]

    "mpu/insert"
    @["Append rows to a sheet"
      "(mpu/insert :s \"ID\" :n \"Sheet1\" \"[{\\\"id\\\":42}]\")"]

    "mpu/upsert"
    @["Insert or update rows by a key field"
      "(mpu/upsert :s \"ID\" :n \"Sheet1\" :key \"id\" \"[{\\\"id\\\":1}]\")"]

    "mpu/keys"
    @["Read header keys (first row) from a sheet"
      "(mpu/keys :s \"SHEET_ID\" :n \"Sheet1\")"]

    "mpu/info"
    @["Metadata for a spreadsheet (title, sheets, ...)"
      "(mpu/info :s \"SHEET_ID\")"]

    "mpu/batch-get"
    @["Batch-read one or more ranges from a spreadsheet"
      "(mpu/batch-get :s \"ID\" :r \"Sheet1!A1:B2\")"
      "(mpu/batch-get 54 :n \"UNIT\")   # full sheet via -n"]

    "mpu/batch-get-all"
    @["Batch-read values AND formulas, merged per cell"
      "(mpu/batch-get-all 54 :n \"UNIT\")"]

    "mpu/batch-update"
    @["Batch-update data across sheets"
      "(mpu/batch-update :s \"ID\" \"{...json...}\")"]

    "mpu/values-update"
    @["Low-level values.batchUpdate passthrough"
      "(mpu/values-update :s \"ID\" \"{...json...}\")"]

    "mpu/delete"
    @["Delete a spreadsheet (destructive!)"
      "(mpu/delete :s \"SHEET_ID\")"]

    "mpu/create"
    @["Create a new spreadsheet"
      "(mpu/create :email \"me@x\" :name \"New Sheet\")"]

    "mpu/copy"
    @["Copy a spreadsheet from a template"
      "(mpu/copy :folder-url \"...\" :name \"N\" :template \"T\")"]

    "mpu/folder"
    @["Move spreadsheet to a Drive folder"
      "(mpu/folder :folder-url \"...\" :name \"N\")"]

    "mpu/sharing"
    @["Set sharing/access permissions"
      "(mpu/sharing :s \"ID\" :access \"anyone\" :perm \"reader\")"]

    "mpu/protection"
    @["Set protected ranges on a sheet"
      "(mpu/protection :s \"ID\" :n \"Sheet1\")"]

    "mpu/client"
    @["Get a single client by ID from cache or API"
      "(mpu/client \"42\")"
      "(mpu/client \"42\" :fields \"name,email\")"]

    "mpu/clients"
    @["Fetch and cache all clients from sl-back"
      "(mpu/clients)"]

    "mpu/token"
    @["Fetch and cache the sl-back JWT (10min TTL)"
      "(mpu/token)"]

    "mpu/update-spreadsheets"
    @["Refresh the cached list of client spreadsheets"
      "(mpu/update-spreadsheets)"]

    "mpu/ldb"
    @["Run SQL on the LOCAL postgres schema for a client"
      "(mpu/ldb \"42\" \"SELECT COUNT(*) FROM wb_cards\")"]

    "mpu/rdb"
    @["Run SQL on the REMOTE postgres schema for a client"
      "(mpu/rdb \"42\" \"SELECT * FROM wb_cards LIMIT 10\")"]

    "mpu/lsdb"
    @["Run SQL on local PG with explicit --scheme"
      "(mpu/lsdb :scheme \"schema_42\" \"SELECT 1\")"]

    "mpu/rsdb"
    @["Run SQL on remote PG with explicit --scheme and --host"
      "(mpu/rsdb :scheme \"s_42\" :host \"sl-1\" \"SELECT 1\")"]

    "mpu/config"
    @["Show or set top-level options in config.json"
      "(mpu/config)                         # list all"
      "(mpu/config \"forceCache\" \"use\")      # cache-only mode"
      "(mpu/config \"forceCache\" \"300\")      # 5-min TTL (token keeps 10m)"]

    "mpu/config-path"
    @["Print path to ~/.config/mpu/config.json"
      "(mpu/config-path)"]

    # ── Core Janet functions ─────────────────────────────────────
    "map"
    @["Apply f to each element — returns tuple or array"
      "(map inc [1 2 3])           # → (2 3 4)"
      "(map |(* $ $) @[1 2 3])     # → @[1 4 9]"]

    "filter"
    @["Keep elements where pred is truthy"
      "(filter odd? [1 2 3 4])     # → @[1 3]"]

    "reduce"
    @["Fold with initial value"
      "(reduce + 0 [1 2 3 4])      # → 10"]

    "reduce2"
    @["Fold without initial value (uses first element)"
      "(reduce2 + [1 2 3 4])       # → 10"]

    "each"
    @["Run body for each element (side effects)"
      "(each x [1 2 3] (print x))"]

    "get"
    @["Lookup by key/index, optional default"
      "(get @{:a 1} :a)            # → 1"
      "(get @[10 20] 1)            # → 20"
      "(get @{} :missing :default) # → :default"]

    "get-in"
    @["Walk nested collection along a path"
      "(get-in data [:users 0 :name])"]

    "put"
    @["Mutate a value at key/index in place, return the collection"
      "(put @{:a 1} :a 99)         # → @{:a 99}"]

    "put-in"
    @["Mutate a nested value in place, creating intermediate tables"
      "(put-in obj [:user :role] \"admin\")"]

    "update"
    @["Apply f to value at key, in place"
      "(update @{:n 1} :n inc)     # → @{:n 2}"]

    "update-in"
    @["Apply f to a nested value at path"
      "(update-in data [:counts :hits] inc)"]

    "keys"
    @["Array of keys in struct/table/array indices"
      "(keys @{:a 1 :b 2})         # → @[:a :b]"]

    "values"
    @["Array of values in struct/table"
      "(values @{:a 1 :b 2})       # → @[1 2]"]

    "pairs"
    @["Array of [key value] pairs"
      "(pairs @{:a 1})             # → @[[:a 1]]"]

    "length"
    @["Size of a collection or string"
      "(length [1 2 3])            # → 3"]

    "array?"  @["True if arg is a mutable array @[...]." "(array? @[1 2])     # → true"]
    "tuple?"  @["True if arg is an immutable tuple [...]." "(tuple? [1 2])      # → true"]
    "table?"  @["True if arg is a mutable table @{...}." "(table? @{:a 1})    # → true"]
    "struct?" @["True if arg is an immutable struct {...}." "(struct? {:a 1})    # → true"]
    "string?" @["True if arg is a string." "(string? \"x\")      # → true"]
    "number?" @["True if arg is a number." "(number? 1.5)       # → true"]
    "nil?"    @["True if arg is nil." "(nil? nil)          # → true"]

    "string/split"
    @["Split a string by a separator"
      "(string/split \",\" \"a,b,c\")  # → @[\"a\" \"b\" \"c\"]"]

    "string/join"
    @["Join strings with a separator"
      "(string/join [\"a\" \"b\"] \",\") # → \"a,b\""]

    "string/format"
    @["Printf-style formatting"
      "(string/format \"%d items\" 5) # → \"5 items\""]

    "postwalk"
    @["Transform a tree bottom-up — apply f to every node"
      "(postwalk |(if (number? $) (inc $) $) data)"]

    "prewalk"
    @["Transform a tree top-down"
      "(prewalk f data)"]

    "freeze"
    @["Deeply convert mutable to immutable (array→tuple, table→struct)"
      "(freeze @[1 2 3])           # → [1 2 3]"]

    "thaw"
    @["Deeply convert immutable to mutable"
      "(thaw [1 2 3])              # → @[1 2 3]"]

    "from-pairs"
    @["Build a struct from [key value] pairs"
      "(from-pairs @[[:a 1] [:b 2]]) # → {:a 1 :b 2}"]

    "seq"
    @["Comprehension-style sequence generator"
      "(seq [x :in [1 2 3] :when (odd? x)] (* x x))"
      "# → @[1 9]"]

    "loop"
    @["Side-effect loop with :in, :when, :while"
      "(loop [x :in [1 2 3]] (print x))"]

    "inc"  @["Increment by 1." "(inc 5)             # → 6"]
    "dec"  @["Decrement by 1." "(dec 5)             # → 4"]
    "sort" @["Sort a collection (mutating arrays, new tuple for tuples)." "(sort @[3 1 2])     # → @[1 2 3]"]
    "sort-by" @["Sort by key function." "(sort-by |($ :age) people)"]
    "take" @["First n elements." "(take 2 [1 2 3 4])  # → (1 2)"]
    "drop" @["All but first n." "(drop 2 [1 2 3 4])  # → (3 4)"]

    # ── JSON (spork/json, vendored) ──────────────────────────────
    "json/decode"
    @["Parse JSON into Janet value"
      "(json/decode \"[1,2,3]\")      # → @[1 2 3]"
      "(json/decode str true)       # keys become keywords"
      "(json/decode str nil true)   # null → nil (default: :null)"]

    "json/encode"
    @["Serialize Janet value to JSON (returns buffer)"
      "(json/encode @{:a 1})        # → @\"{\\\"a\\\":1}\""
      "(json/encode data \"  \")      # pretty-print"]

    # ── REPL magics ───────────────────────────────────────────────
    "?"          @["Quick help. (?) for overview, (? mpu/get) for a command." "(?)" "(? mpu/get)"]
    "commands"   @["List all registered mpu commands." "(commands)"]
    "apropos"    @["Search commands by name or description." "(apropos \"sheet\")"]
    "%time"      @["Time an expression, return its value." "(%time (mpu/token))"]
    "%who"       @["List user-defined bindings." "(%who)"]
    "%hist"      @["Show recent REPL inputs." "(%hist)" "(%hist 50)"]
    "%load"      @["Execute a Janet script file." "(%load \"path.janet\")"]
    "%env"       @["REPL environment summary." "(%env)"]
    "%pp"        @["Pretty-print a value with syntax colors." "(%pp data)"]
    "%highlight" @["Highlight a Janet source string." "(%highlight \"(+ 1 2)\")"]
    "%reset"     @["Reset result history (_, __, ___)." "(%reset)"]
    "set-theme"  @["Switch the highlight color theme." "(set-theme theme/light)"]
  })

# ── Registration ─────────────────────────────────────────────────────────

(defn hint/register
  "Register or override a hint for `name`. Remaining args are the display
   lines (first line is the description, rest are examples). Each subsequent
   call replaces the prior registration."
  [name & lines]
  (put *hint-examples* name (array ;lines)))

# ── Lookup ───────────────────────────────────────────────────────────────

(defn- trim-lines [lines]
  "Trim leading/trailing blank lines and cap to *hint-max-lines*."
  (def out @[])
  (var started false)
  (each l lines
    (cond
      (and (not started) (= (string/trim l) "")) nil
      (do (set started true) (array/push out l) false) nil))
  # Drop trailing blanks.
  (while (and (> (length out) 0)
              (= (string/trim (get out (- (length out) 1))) ""))
    (array/pop out))
  # Cap.
  (if (> (length out) *hint-max-lines*)
    (array/slice out 0 *hint-max-lines*)
    out))

(defn- from-cobra
  "For mpu/* names, build hint lines from the cobra command's Short/Long."
  [name]
  (when (string/has-prefix? "mpu/" name)
    (def short-name (string/slice name 4))
    (def info (repl/doc short-name))
    (when (and info (not= info ""))
      (def lines (string/split "\n" info))
      (def out @[])
      (array/push out (string name))
      (each l lines
        (when (not= (string/trim l) "")
          (array/push out l)))
      out)))

(defn- from-docstring
  "Pull the :doc of a Janet binding, split into lines."
  [name]
  (def sym (try (symbol name) ([_] nil)))
  (when sym
    (def info (try (dyn sym) ([_] nil)))
    (when info
      (def doc (get info :doc))
      (when (and (string? doc) (not= doc ""))
        (def out @[])
        (array/push out (string "(" name ")"))
        (each l (string/split "\n" doc)
          (array/push out l))
        out))))

(defn hint/for
  "Return the formatted hint for `name` (string), or empty when none.
   Lookup: custom registry → mpu cobra doc → Janet docstring."
  [name]
  (def lines
    (or (get *hint-examples* name)
        (from-cobra name)
        (from-docstring name)))
  (if (or (nil? lines) (empty? lines))
    ""
    (string/join (trim-lines lines) "\n")))
