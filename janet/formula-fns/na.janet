# NA() — sheets error sentinel. We use the :na keyword.

(formula-eval/register "NA"
  (fn [args ctx] :na))
