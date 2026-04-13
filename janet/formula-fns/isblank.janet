# ISBLANK(value) — true when cell contains no value.
# https://support.google.com/docs/answer/3093290
#
# Semantics: nil (absent) and empty string are blank; 0 is NOT blank.

(formula-eval/register "ISBLANK"
  (fn [args ctx]
    (when (empty? args) (error "ISBLANK needs a value"))
    (def v (formula-eval/eval (get args 0) ctx))
    (or (nil? v) (and (string? v) (empty? v)))))
