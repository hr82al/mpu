/**
 * Слова грамматики (`platform/line-grammar.md` [D.1];
 * `platform/value-expression.md` [D.2]): открытие группы, закрытие, знак
 * литерала и первичное выражение stdin. Литералом эти слова больше нигде
 * не пишутся — разбор, справка, подсказки и описание тула читают их отсюда.
 */
export const GRAMMAR = {
  open: "do",
  close: "end",
  literal: "--",
  stdin: "stdin",
} as const;
