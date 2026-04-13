# REGEXREPLACE(text, regex, replacement) — Janet PEG differs from
# re2; here we convert the regex with a small helper or fall back to
# a literal string/replace-all when the pattern is a plain literal.
# TODO: proper RE2-compatible regex engine. For now:
# interpret the regex naively via Janet's peg compilation from a regex
# string using a simple transform (supports . \d \s \w [abc] etc).
#
# Fallback: literal replace if pattern contains no metacharacters.

(def- re-meta "\\.^$*+?()[]{}|")

(defn- has-meta? [s]
  (var found false)
  (each c s
    (when (string/find (string/from-bytes c) re-meta)
      (set found true)))
  found)

# Convert a subset of regex syntax to Janet PEG.
(defn- regex->peg [re]
  (var peg @[])
  (def n (length re))
  (var i 0)
  (while (< i n)
    (def c (get re i))
    (cond
      (= c (chr "\\"))
      (when (< (+ i 1) n)
        (def esc (get re (+ i 1)))
        (cond
          (= esc (chr "d")) (array/push peg :d)
          (= esc (chr "s")) (array/push peg :s)
          (= esc (chr "w")) (array/push peg :w)
          (= esc (chr "D")) (array/push peg [:not :d])
          (= esc (chr "S")) (array/push peg [:not :s])
          (= esc (chr "W")) (array/push peg [:not :w])
          (array/push peg (string/from-bytes esc)))
        (+= i 2))

      (= c (chr "."))
      (do (array/push peg 1) (++ i))

      (= c (chr "+"))
      (let [prev (array/pop peg)] (array/push peg ~(some ,prev)) (++ i))

      (= c (chr "*"))
      (let [prev (array/pop peg)] (array/push peg ~(any ,prev)) (++ i))

      (= c (chr "?"))
      (let [prev (array/pop peg)] (array/push peg ~(opt ,prev)) (++ i))

      (do (array/push peg (string/from-bytes c)) (++ i))))
  ~(* ,;peg))

(defn- compiled-pattern [re-str]
  (if (has-meta? re-str)
    ~(any (+ (/ (* (constant :hit) (<- ,(regex->peg re-str))) (,identity ,identity))
             (<- 1)))
    re-str))

(formula-eval/register "REGEXREPLACE"
  (fn [args ctx]
    (def text (string (formula-eval/eval (get args 0) ctx)))
    (def re   (string (formula-eval/eval (get args 1) ctx)))
    (def rpl  (string (formula-eval/eval (get args 2) ctx)))
    (if (has-meta? re)
      (let [grammar ~{:main (any (+ (/ (<- ,(regex->peg re)) ,(fn [_] rpl))
                                    (<- 1)))}
            parts (peg/match grammar text)]
        (if parts (string/join parts) text))
      (string/replace-all re rpl text))))
