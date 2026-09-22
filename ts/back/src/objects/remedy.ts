/**
 * Подсказки отказов (`platform/line-grammar.md`, «Отказы с подсказкой»):
 * подсказка — строка вызова целиком.
 */

import type { Remedy } from "./protocol.ts";

/** Слово строки, как его набрать в оболочке: с пробелом — в кавычках. */
export function spoken(word: string): string {
  return word.includes(" ") ? JSON.stringify(word) : word;
}

/** Строка вызова из адреса и слов, набранных за ним. */
export function line(address: string, words: readonly string[]): string {
  return [address, ...words.map(spoken)].join(" ");
}

/** Подсказать нечего. Единственный null-объект модуля. */
export const NO_REMEDY: Remedy = { spell: () => "" };
