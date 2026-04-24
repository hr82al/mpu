# Shared COUNTIF/SUMIF/AVERAGEIF criteria parser.
# Examples: 5, ">2", "<=10", "<>abc", "a" (exact equals).

(defn formula-eval/parse-criterion [crit]
  (if (string? crit)
    (let [s crit]
      (cond
        (and (>= (length s) 2) (= ">=" (string/slice s 0 2)))
        [:ge (or (scan-number (string/slice s 2)) (string/slice s 2))]
        (and (>= (length s) 2) (= "<=" (string/slice s 0 2)))
        [:le (or (scan-number (string/slice s 2)) (string/slice s 2))]
        (and (>= (length s) 2) (= "<>" (string/slice s 0 2)))
        [:ne (or (scan-number (string/slice s 2)) (string/slice s 2))]
        (and (>= (length s) 1) (= ">" (string/slice s 0 1)))
        [:gt (or (scan-number (string/slice s 1)) (string/slice s 1))]
        (and (>= (length s) 1) (= "<" (string/slice s 0 1)))
        [:lt (or (scan-number (string/slice s 1)) (string/slice s 1))]
        (and (>= (length s) 1) (= "=" (string/slice s 0 1)))
        [:eq (or (scan-number (string/slice s 1)) (string/slice s 1))]
        [:eq s]))
    [:eq crit]))

(defn formula-eval/matches-criterion [v crit]
  (def [op operand] crit)
  (case op
    :eq (= v operand)
    :ne (not= v operand)
    :gt (and (number? v) (number? operand) (> v operand))
    :ge (and (number? v) (number? operand) (>= v operand))
    :lt (and (number? v) (number? operand) (< v operand))
    :le (and (number? v) (number? operand) (<= v operand))))
