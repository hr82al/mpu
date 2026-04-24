# KEYSQUERY(keys, data, querystring, headers) — named wrapper.
#
# Body (from the sheet's defined names):
#
#   =LET(
#     regexps;     MAP(FLATTEN(keys);
#                      LAMBDA(key; IF(key=""; ""; "\b" & key & "\b")));
#     indexes;     MAKEARRAY(ROWS(regexps); 1;
#                            LAMBDA(r; c; IF(INDEX(regexps; r)=""; ; r)));
#     parsedquery; REDUCE(
#                    querystring; FILTER(indexes; indexes<>"");
#                    LAMBDA(querystring; i;
#                      REGEXREPLACE(querystring;
#                                   INDEX(regexps; i);
#                                   "Col" & i)));
#     QUERY(data; parsedquery; headers)
#   )
#
# Parsing that body string into an AST once at load time is cheap — the
# handler just wraps it in an outer LET that binds the four params.

(def- keysquery/*body-ast*
  (formula-parser/parse
    ``=LET(
        regexps;     MAP(FLATTEN(keys);
                         LAMBDA(key; IF(key=""; ""; "\b" & key & "\b")));
        indexes;     MAKEARRAY(ROWS(regexps); 1;
                               LAMBDA(r; c; IF(INDEX(regexps; r)=""; ; r)));
        parsedquery; REDUCE(
                       querystring; FILTER(indexes; indexes<>"");
                       LAMBDA(querystring; i;
                         REGEXREPLACE(querystring;
                                      INDEX(regexps; i);
                                      "Col" & i)));
        QUERY(data; parsedquery; headers)
      )``))

(formula-eval/register "KEYSQUERY"
  (fn [args ctx]
    (when (< (length args) 4)
      (error "KEYSQUERY: expected (keys, data, querystring, headers)"))
    (formula-eval/eval
      [:call "LET"
             [[:name "keys"]        (get args 0)
              [:name "data"]        (get args 1)
              [:name "querystring"] (get args 2)
              [:name "headers"]     (get args 3)
              keysquery/*body-ast*]]
      ctx)))
