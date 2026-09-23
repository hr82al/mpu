/**
 * Строка — программа или однокомандная (`platform/evaluator.md`, «Где
 * исполняется»): решают слова. Одно выражение без новых слов идёт прежним
 * путём побайтово.
 */

import { GRAMMAR } from "../messages/mod.ts";

/** Слова, которые делают строку программой где угодно. */
const PROGRAM_WORDS: ReadonlySet<string> = new Set([
  GRAMMAR.separator,
  GRAMMAR.assign,
  GRAMMAR.comment,
  GRAMMAR.blockEnd,
]);

/** Число, как его пишут в начале выражения: `12`, `-3`, `2.5`. */
export const NUMBER = /^-?\d+(\.\d+)?$/;

/** Параметр блока: `:a` сразу за `do` и за другим параметром. */
export function isParameter(word: string | undefined): boolean {
  return word !== undefined && word.length > 1 &&
    word.startsWith(GRAMMAR.parameter) && word !== GRAMMAR.assign;
}

/** Слово само по себе делает строку программой. */
function marks(word: string, next: string | undefined): boolean {
  if (PROGRAM_WORDS.has(word)) return true;
  if (word.startsWith(GRAMMAR.quote) || word.startsWith(GRAMMAR.variable)) {
    return true;
  }
  return word === GRAMMAR.open && isParameter(next);
}

/**
 * Программа ли строка: новые слова (`.`, `:=`, `rem`, `done`, `^…`,
 * `@…`, `do :p`) где угодно, кроме как за `--`, или число первым словом.
 *
 * @param words слова строки, как их отдала оболочка
 */
export function isProgram(words: readonly string[]): boolean {
  if (words.length > 0 && NUMBER.test(words[0])) return true;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === GRAMMAR.literal) {
      i++;
      continue;
    }
    if (marks(words[i], words[i + 1])) return true;
  }
  return false;
}
