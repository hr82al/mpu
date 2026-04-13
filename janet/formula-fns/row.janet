# ROW([reference]) — row number from a :ref/:range AST, or ctx cell.
(defn- strip-dollars-and-sheet [addr]
  (def clean (if-let [bang (string/find "!" addr)]
               (string/slice addr (+ bang 1))
               addr))
  (def b @"")
  (each c clean
    (unless (= c (chr "$")) (buffer/push-byte b c)))
  (string b))

(formula-eval/register "ROW"
  (fn [args ctx]
    (def addr
      (cond
        (empty? args) (get ctx :addr)
        (let [a (get args 0)]
          (cond
            (= (get a 0) :ref) (get a 1)
            (= (get a 0) :range) (get a 1)
            (errorf "ROW: expected reference, got %j" a)))))
    (when (nil? addr) (error "ROW: no address in context"))
    (get (formula-finder/cell->rc (strip-dollars-and-sheet addr)) 0)))
