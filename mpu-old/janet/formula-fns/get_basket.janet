# GET_BASKET(s_id) — named-function wrapper defined in the sheet.
#
# Body:
#   =IFS(s_id<=143;"01"; s_id<=287;"02"; s_id<=431;"03"; s_id<=719;"04";
#        s_id<=1007;"05"; s_id<=1061;"06"; s_id<=1115;"07"; s_id<=1169;"08";
#        s_id<=1313;"09"; s_id<=1601;"10"; s_id<=1655;"11"; s_id<=1919;"12";
#        s_id<=2045;"13"; s_id<=2189;"14"; s_id<=2405;"15"; s_id>2406;"16")
#
# Note: s_id=2406 matches no condition (gap in the original formula).

(def- get-basket/*body-ast*
  (formula-parser/parse
    ``=IFS(s_id<=143;"01";s_id<=287;"02";s_id<=431;"03";s_id<=719;"04";s_id<=1007;"05";s_id<=1061;"06";s_id<=1115;"07";s_id<=1169;"08";s_id<=1313;"09";s_id<=1601;"10";s_id<=1655;"11";s_id<=1919;"12";s_id<=2045;"13";s_id<=2189;"14";s_id<=2405;"15";s_id>2406;"16")``))

(formula-eval/register "GET_BASKET"
  (fn [args ctx]
    (when (< (length args) 1)
      (error "GET_BASKET: expected (s_id)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "s_id"] (get args 0)
              get-basket/*body-ast*]]
      ctx)))
