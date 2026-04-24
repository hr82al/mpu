# COLUMN([reference]) — 1-based column of a :ref/:range AST or ctx cell.
(formula-eval/register "COLUMN"
  (fn [args ctx]
    (def addr
      (cond
        (empty? args) (get ctx :addr)
        (let [a (get args 0)]
          (cond
            (= (get a 0) :ref) (get a 1)
            (= (get a 0) :range) (get a 1)
            (errorf "COLUMN: expected reference, got %j" a)))))
    (when (nil? addr) (error "COLUMN: no address in context"))
    (def clean (if-let [bang (string/find "!" addr)]
                 (string/slice addr (+ bang 1))
                 addr))
    (def stripped (do (def b @"")
                      (each c clean
                        (unless (= c (chr "$")) (buffer/push-byte b c)))
                      (string b)))
    (get (formula-finder/cell->rc stripped) 1)))
