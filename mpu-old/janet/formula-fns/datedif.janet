# DATEDIF(start, end, unit) — "Y", "M", "D" (whole units).
(formula-eval/register "DATEDIF"
  (fn [args ctx]
    (def start (formula-eval/eval (get args 0) ctx))
    (def end   (formula-eval/eval (get args 1) ctx))
    (def unit  (string/ascii-upper
                 (string (formula-eval/eval (get args 2) ctx))))
    (def sd (formula-eval/serial->date start))
    (def ed (formula-eval/serial->date end))
    (cond
      (= unit "D") (- end start)

      (= unit "M")
      (let [my (+ (* 12 (sd :year)) (sd :month))
            ey (+ (* 12 (ed :year)) (ed :month))
            diff (- ey my)]
        (if (< (ed :month-day) (sd :month-day)) (- diff 1) diff))

      (= unit "Y")
      (let [y (- (ed :year) (sd :year))]
        (if (or (< (ed :month) (sd :month))
                (and (= (ed :month) (sd :month))
                     (< (ed :month-day) (sd :month-day))))
          (- y 1) y))

      (errorf "DATEDIF: unsupported unit %s" unit))))
