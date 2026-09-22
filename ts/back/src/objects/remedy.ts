/**
 * Подсказки к слову за значением ключа (`platform/line-grammar.md`,
 * «Отказы с подсказкой»): подсказка — строка вызова целиком.
 */

import { GRAMMAR, HELP_FLAG } from "../messages/mod.ts";
import { HELP_SELECTOR, type Remedy } from "./protocol.ts";

/** Слово строки, как его набрать в оболочке: с пробелом — в кавычках. */
export function spoken(word: string): string {
  return word.includes(" ") ? JSON.stringify(word) : word;
}

/** Строка вызова из адреса и слов, набранных за ним. */
function line(address: string, words: readonly string[]): string {
  return [address, ...words.map(spoken)].join(" ");
}

/** Подсказать нечего. */
const NO_REMEDY: Remedy = { spell: () => "" };

/** Справку просят последним словом объекту, а не значению. */
const LAST_WORD: Remedy = {
  spell: (address) =>
    `; справка — последним словом: ${line(address, [HELP_SELECTOR])}`,
};

/** Формат — сообщение результату после закрытия. */
class AfterClose implements Remedy {
  readonly #format: string;

  constructor(format: string) {
    this.#format = format;
  }

  spell(address: string, taken: readonly string[]): string {
    const call = line(address, [...taken, GRAMMAR.close, this.#format]);
    return `; формат — после ${GRAMMAR.close}: ${call}`;
  }
}

const HELP_WORDS: ReadonlySet<string> = new Set([HELP_SELECTOR, HELP_FLAG]);

/**
 * Подсказка к слову за значением: справка — последним словом, формат из
 * `formats` — после закрытия; прочему подсказать нечего.
 *
 * @param word слово за значением
 * @param formats форматы результата приёмника
 */
export function remedyFor(word: string, formats: readonly string[]): Remedy {
  if (HELP_WORDS.has(word)) return LAST_WORD;
  if (formats.includes(word)) return new AfterClose(word);
  return NO_REMEDY;
}
