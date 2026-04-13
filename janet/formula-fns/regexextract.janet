# REGEXEXTRACT(text, regex) — return the first regex match.

(def- re-meta "\\.^$*+?()[]{}|")

(defn- has-meta? [s]
  (var found false)
  (each c s
    (when (string/find (string/from-bytes c) re-meta) (set found true)))
  found)

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
          (array/push peg (string/from-bytes esc)))
        (+= i 2))
      (= c (chr ".")) (do (array/push peg 1) (++ i))
      (= c (chr "+")) (let [p (array/pop peg)] (array/push peg ~(some ,p)) (++ i))
      (= c (chr "*")) (let [p (array/pop peg)] (array/push peg ~(any ,p)) (++ i))
      (= c (chr "?")) (let [p (array/pop peg)] (array/push peg ~(opt ,p)) (++ i))
      (do (array/push peg (string/from-bytes c)) (++ i))))
  ~(<- (* ,;peg)))

(formula-eval/register "REGEXEXTRACT"
  (fn [args ctx]
    (def text (string (formula-eval/eval (get args 0) ctx)))
    (def re   (string (formula-eval/eval (get args 1) ctx)))
    (def pat (if (has-meta? re) (regex->peg re) re))
    (def res (peg/match ~{:main (+ ,pat (* 1 :main))} text))
    (if res (get res 0) (error "REGEXEXTRACT: no match"))))
