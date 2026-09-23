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

/**
 * Строка команды со словами флага `words` (`--md`, `--json`): они встают
 * перед первым `--` — за ним стали бы позиционными словами команды.
 */
export function flagged(
  argv: readonly string[],
  words: readonly string[],
): string[] {
  const at = argv.indexOf(GRAMMAR.literal);
  const cut = at < 0 ? argv.length : at;
  return [...argv.slice(0, cut), ...words, ...argv.slice(cut)];
}
