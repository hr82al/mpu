# formula-fns/cl_query.janet — Sheets function "CL_QUERY".
#
# Receives raw AST args; evaluate with (formula-eval/eval arg ctx).
# Replace the stub body with real behavior. Delete this file to
# regenerate the scaffold on the next auto-run.

(formula-eval/register "CL_QUERY"
  (fn [args ctx]
    (def evaluated (map (fn [a] (formula-eval/eval a ctx)) args))
    (printf "# STUB %s at %s: %j" "CL_QUERY" (get ctx :addr) evaluated)
    [:stub "CL_QUERY"]))