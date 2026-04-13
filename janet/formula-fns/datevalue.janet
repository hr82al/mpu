# DATEVALUE("YYYY-MM-DD") — minimal ISO parse.
(formula-eval/register "DATEVALUE"
  (fn [args ctx]
    (def s (formula-eval/eval (get args 0) ctx))
    (def parts (string/split "-" s))
    (when (not= 3 (length parts))
      (errorf "DATEVALUE: expected YYYY-MM-DD, got %j" s))
    (formula-eval/ymd->serial
      (scan-number (get parts 0))
      (scan-number (get parts 1))
      (scan-number (get parts 2)))))
