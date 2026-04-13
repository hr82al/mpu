# formula-fns/map.janet — Sheets function "MAP".
#
# Receives raw AST args; evaluate with (formula-eval/eval arg ctx).
# Replace the stub body with real behavior. Delete this file to
# regenerate the scaffold on the next auto-run.

(formula-eval/register "MAP"
  (fn [args ctx]
    (def evaluated (map (fn [a] (formula-eval/eval a ctx)) args))
    (printf "# STUB %s at %s: %j" "MAP" (get ctx :addr) evaluated)
    [:stub "MAP"]))