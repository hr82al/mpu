/**
 * Строка для нынешней диспетчеризации (`platform/line-grammar.md`): она
 * не знает слов грамматики, поэтому получает набранное без ведущего `do`
 * и без закрытия с тем, что за ним.
 */

import { flagged, GRAMMAR } from "../messages/mod.ts";

/** Как лист отдаёт строку нынешней диспетчеризации. */
export interface Order {
  argv(line: readonly string[]): readonly string[];
}

/** Без открытия группы первым словом. */
function unopened(line: readonly string[]): readonly string[] {
  return line[0] === GRAMMAR.open ? line.slice(1) : line;
}

/**
 * Свой хвост: строка до закрытия без `--` перед ним. Слова пути не бывают
 * закрытием — оно зарезервировано, — так что первое такое слово и есть
 * закрытие хвоста. Правило то же, что у разбора хвоста
 * (`messages/words.ts`, `intoTail`); `--` перед экранированным словом
 * здесь остаётся — его снимает сама нынешняя диспетчеризация, как любой
 * `--` перед позиционным словом.
 */
export const OWN: Order = {
  argv(line) {
    const words = unopened(line);
    const at = words.findIndex((word, i) =>
      word === GRAMMAR.close && words[i - 1] !== GRAMMAR.literal
    );
    return at < 0 ? words : words.slice(0, at);
  },
};

/** Чужой хвост: закрытия в нём нет, строка идёт как есть. */
export const FOREIGN: Order = { argv: unopened };

/**
 * Строка с выбранным форматом: слова прежнего флага встают перед первым
 * `--` — за ним они стали бы позиционными словами команды.
 *
 * @param order как строку собирает лист
 * @param words слова флага формата (`--md`)
 */
export function formatted(order: Order, words: readonly string[]): Order {
  return {
    argv: (line) => flagged(order.argv(line), words),
  };
}
