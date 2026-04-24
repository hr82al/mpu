# BY_NM_IDS(nm_ids; callback) — named-function wrapper defined in the sheet.
#
# Body:
#   =MAP(nm_ids; LAMBDA(nm_id; IF(nm_id=""; ; callback(nm_id))))
#
# Each element of nm_ids is forwarded to callback unless it is blank,
# in which case the cell is left empty (nil).

(def- by-nm-ids/*body-ast*
  (formula-parser/parse
    ``=MAP(nm_ids; LAMBDA(nm_id; IF(nm_id=""; ; callback(nm_id))))``)  )

(formula-eval/register "BY_NM_IDS"
  (fn [args ctx]
    (when (< (length args) 2)
      (error "BY_NM_IDS: expected (nm_ids, callback)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "nm_ids"]   (get args 0)
              [:name "callback"] (get args 1)
              by-nm-ids/*body-ast*]]
      ctx)))
