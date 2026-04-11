# help.janet — Help and documentation system for the mpu REPL.

(defn commands
  "List all registered mpu commands."
  []
  (def raw (repl/commands))
  (when (and raw (not= raw ""))
    (def lines (string/split "\n" raw))
    (each line lines
      (when (not= line "")
        (def parts (string/split "\t" line))
        (def name (get parts 0))
        (def doc  (get parts 1 ""))
        (prin (paint :mpu (string "  mpu/" name)))
        (when (not= doc "")
          (prin (paint :nil (string " — " doc))))
        (print)))))

(defn ?
  "Quick help. (?) for overview, (? mpu/get) for command help."
  [& args]
  (if (empty? args)
    (do
      (print)
      (print (string (c :bold) (c :prompt) "  mpu janet REPL" (cr)))
      (print)
      (print (string "  " (paint :mpu "(commands)")        "      list all mpu commands"))
      (print (string "  " (paint :mpu "(? mpu/get)")       "      help for a specific command"))
      (print (string "  " (paint :mpu "(apropos \"text\")")  "   search commands by keyword"))
      (print (string "  " (paint :mpu "(doc fn)")           "          Janet doc for any function"))
      (print)
      (print (string "  " (paint :macro "(%time expr)")      "      time an expression"))
      (print (string "  " (paint :macro "(%who)")            "            list user-defined bindings"))
      (print (string "  " (paint :macro "(%hist)")           "           show input history"))
      (print (string "  " (paint :macro "(%hist-search s)")  "  search history"))
      (print (string "  " (paint :macro "(%env)")            "            REPL environment info"))
      (print (string "  " (paint :macro "(%load \"file\")")    "     load and execute a Janet file"))
      (print (string "  " (paint :macro "(%pp val)")         "         pretty-print a value"))
      (print (string "  " (paint :macro "(%highlight src)")  "  highlight Janet source string"))
      (print (string "  " (paint :macro "(set-theme t)")     "    switch color theme"))
      (print)
      (print (string "  " (paint :nil "_")    " / " (paint :nil "__")   " / " (paint :nil "___")  "    last three results"))
      (print (string "  " (paint :nil "_i")   " / " (paint :nil "_ii")  " / " (paint :nil "_iii") "  last three inputs"))
      (print (string "  " (paint :nil "*counter*") "           current execution counter"))
      (print)
      (print (string "  " (paint :comment "Calling mpu commands:")))
      (print (string "  " (paint :mpu "(mpu/get") " " (paint :opt ":spreadsheet-id") " " (paint :str "\"ID\"")
                     " " (paint :opt ":sheet-name") " " (paint :str "\"Sheet1\"") (paint :paren ")")))
      (print (string "  " (paint :mpu "(mpu/client") " " (paint :str "\"42\"")
                     " " (paint :opt ":fields") " " (paint :str "\"name,email\"") (paint :paren ")")))
      (print (string "  " (paint :mpu "(mpu/ldb") " " (paint :str "\"42\"") " " (paint :str "\"SELECT 1\"") (paint :paren ")")))
      (print)
      (print (string "  " (paint :nil "Tab")    "     completion   "
                     (paint :nil "Ctrl-R") "  history search"))
      (print (string "  " (paint :nil "Ctrl-D") "  exit           "
                     (paint :nil "Ctrl-C") "  cancel line"))
      (print))
    (do
      (def name (string (first args)))
      (def raw-name
        (if (string/has-prefix? "mpu/" name)
          (string/slice name 4)
          name))
      (def info (repl/doc raw-name))
      (if (and info (not= info ""))
        (do
          (print)
          (print (string (c :bold) (c :mpu) "  " name (cr)))
          (print)
          (each line (string/split "\n" info)
            (print (string "  " line)))
          (print)
          # show keyword flags
          (def flags-raw (repl/flags raw-name))
          (when (and flags-raw (not= flags-raw ""))
            (print (string "  " (paint :comment "Keyword flags:")))
            (def flags (string/split "\n" flags-raw))
            (each f flags
              (when (and (not= f "") (string/has-prefix? "--" f))
                (print (string "    " (paint :opt (string ":" (string/slice f 2)))))))
            (print)))
        (print (paint :nil (string "  no help for " name)))))))

(defn apropos
  "Search commands whose name or doc contains the given pattern."
  [pattern]
  (def raw (repl/commands))
  (when (and raw (not= raw ""))
    (def pat (string/ascii-lower pattern))
    (var found 0)
    (def lines (string/split "\n" raw))
    (each line lines
      (when (not= line "")
        (def parts (string/split "\t" line))
        (def name (get parts 0))
        (def doc  (get parts 1 ""))
        (when (or (string/find pat (string/ascii-lower name))
                  (string/find pat (string/ascii-lower doc)))
          (prin (paint :mpu (string "  mpu/" name)))
          (when (not= doc "")
            (prin (paint :nil (string " — " doc))))
          (print)
          (++ found))))
    (when (= found 0)
      (print (paint :nil (string "  no matches for " (string/format "%q" pattern)))))))
