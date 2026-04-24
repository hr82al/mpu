# CL_QUERY(query_text, header_rows) — named-function wrapper this sheet
# defines. Equivalent to:
#
#   =KEYSQUERY(checklist!$A$1:$ADT$1;
#              checklist!$A$3:$ADT;
#              query_text;
#              header_rows)
#
# Implementation: rewrite the call as a KEYSQUERY AST so ranges on the
# `checklist` sheet go through the cross-sheet loader lazily when
# KEYSQUERY actually touches them.

(formula-eval/register "CL_QUERY"
  (fn [args ctx]
    (when (< (length args) 2)
      (error "CL_QUERY: expected (query_text, header_rows)"))
    (formula-eval/eval
      [:call "KEYSQUERY"
             [[:range "checklist!$A$1" "$ADT$1"]
              [:range "checklist!$A$3" "$ADT"]
              (get args 0)
              (get args 1)]]
      ctx)))
