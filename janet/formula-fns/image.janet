# formula-fns/image.janet — Sheets function "IMAGE".
#
# Receives raw AST args; evaluate with (formula-eval/eval arg ctx).
# Replace the stub body with real behavior. Delete this file to
# regenerate the scaffold on the next auto-run.

(formula-eval/register "IMAGE"
  (fn [args ctx]
    (def evaluated (map (fn [a] (formula-eval/eval a ctx)) args))
    (printf "# STUB %s at %s: %j" "IMAGE" (get ctx :addr) evaluated)
    [:stub "IMAGE"]))