# formula-fns/keysquery.janet — Sheets function "KEYSQUERY".
#
# Receives raw AST args; evaluate with (formula-eval/eval arg ctx).
# Replace the stub body with real behavior. Delete this file to
# regenerate the scaffold on the next auto-run.

(formula-eval/register "KEYSQUERY"
  (fn [args ctx]
    (def evaluated (map (fn [a] (formula-eval/eval a ctx)) args))
    (printf "# STUB %s at %s: %j" "KEYSQUERY" (get ctx :addr) evaluated)
    [:stub "KEYSQUERY"]))