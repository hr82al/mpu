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

/** Слово — ключ ключевого сообщения: `id:`; `^итог:` — начало текста. */
export function isKey(word: string): boolean {
  return word.length > 1 && word.endsWith(GRAMMAR.parameter) &&
    word !== GRAMMAR.assign && !word.startsWith(GRAMMAR.quote);
}

/** Параметр блока: `:a` сразу за `do` и за другим параметром. */
export function isParameter(word: string | undefined): boolean {
  return word !== undefined && word.length > 1 &&
    word.startsWith(GRAMMAR.parameter) && word !== GRAMMAR.assign;
}

/** Лист дерева глазами решения «программа ли строка». */
export interface TextKeysNode {
  readonly leaf: boolean;
  /** Ключи-текст листа: их значение — слово как есть. */
  readonly texts: ReadonlySet<string>;
}

/** Дерево команд глазами решения «программа ли строка». */
export interface TextKeys {
  node(path: readonly string[]): TextKeysNode | undefined;
}

const NO_TEXTS: ReadonlySet<string> = new Set();

/** Ключи-текст листа, которым начинается строка; не лист — пусто. */
function leadingTexts(
  words: readonly string[],
  keys: TextKeys,
): ReadonlySet<string> {
  const path: string[] = [];
  let texts = NO_TEXTS;
  for (const word of words) {
    const node = keys.node([...path, word]);
    if (node === undefined) return texts;
    path.push(word);
    texts = node.leaf ? node.texts : NO_TEXTS;
  }
  return texts;
}

/**
 * Слово значения за ключом-текстом (`text:`, `--text`) строку программой
 * не делает: оно — текст как есть. `^…` и `do` там — выражения.
 */
function asIs(key: string, value: string, texts: ReadonlySet<string>) {
  const name = key.endsWith(GRAMMAR.parameter)
    ? key.slice(0, -GRAMMAR.parameter.length)
    : key.startsWith("--")
    ? key.slice(2)
    : undefined;
  if (name === undefined || !texts.has(name)) return false;
  return !value.startsWith(GRAMMAR.quote) && value !== GRAMMAR.open;
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
 * `@…`, `do :p`) где угодно, кроме как за `--` и на месте значения
 * ключа-текста, или число первым словом.
 *
 * @param words слова строки, как их отдала оболочка
 * @param keys дерево команд: ключи-текст листа, которым строка начата
 */
export function isProgram(words: readonly string[], keys: TextKeys): boolean {
  if (words.length > 0 && NUMBER.test(words[0])) return true;
  const texts = leadingTexts(words, keys);
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    if (words[i] === GRAMMAR.literal) {
      i++;
      continue;
    }
    if (next !== undefined && asIs(words[i], next, texts)) {
      i++;
      continue;
    }
    if (marks(words[i], words[i + 1])) return true;
  }
  return false;
}
