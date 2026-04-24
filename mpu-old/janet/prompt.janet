# prompt.janet — Prompt generation for the mpu REPL.

(var *prompt-fn* nil)

(defn prompt/default
  "Generate the default numbered prompt: mpu:N> "
  []
  (string "\x01" (c :prompt) "\x02" "mpu" "\x01" (cr) "\x02"
          ":" "\x01" (c :counter) "\x02" *counter* "\x01" (cr) "\x02" "> "))

(defn prompt/continuation
  "Prompt for multi-line continuation."
  []
  (def pad (string/repeat " " (+ 4 (length (string *counter*)))))
  (string "\x01" (c :nil) "\x02" pad "... " "\x01" (cr) "\x02"))

(defn prompt/get
  "Return the current prompt string."
  []
  (if *prompt-fn*
    (*prompt-fn*)
    (prompt/default)))

(defn set-prompt
  "Set a custom prompt function: (set-prompt (fn [] \">>> \"))"
  [f]
  (set *prompt-fn* f))

(defn reset-prompt
  "Reset to the default prompt."
  []
  (set *prompt-fn* nil))
