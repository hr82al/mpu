/**
 * Подсказки отказов (`platform/line-grammar.md`, «Отказы с подсказкой";
 * `platform/refusal-object.md`): подсказка — строка вызова целиком. Текст
 * подсказки в stderr и её слова для объекта отказа выводятся из одних слов.
 */

import type { Hint, Remedy } from "./protocol.ts";

/** Слово корня в адресе строки; в словах подсказки его нет. */
export const ROOT_TEXT = "mpu";

/** Слово строки, как его набрать в оболочке: с пробелом — в кавычках. */
export function spoken(word: string): string {
  return word.includes(" ") ? JSON.stringify(word) : word;
}

/** Строка вызова из адреса и слов, набранных за ним. */
export function line(address: string, words: readonly string[]): string {
  return [address, ...words.map(spoken)].join(" ");
}

/** Подсказать нечего. */
export const NO_HINT: Hint = {
  said: () => "",
  words: () => null,
  reason: (own) => own,
};

/** Подсказать нечего. Единственный null-объект модуля. */
export const NO_REMEDY: Remedy = { hint: () => NO_HINT };

/**
 * Строка в тексте отказа: связка `lead`, затем строка вызова. Текст — из
 * тех же слов, что отдаются объекту.
 */
class Spelled implements Hint {
  readonly #lead: string;
  readonly #words: readonly string[];
  readonly #reason: string | undefined;

  /** @param reason вид отказа, если подсказка его называет сама */
  constructor(lead: string, words: readonly string[], reason?: string) {
    this.#lead = lead;
    this.#words = words;
    this.#reason = reason;
  }

  reason(own: string): string {
    return this.#reason ?? own;
  }

  said(): string {
    return `${this.#lead}${line(ROOT_TEXT, this.#words)}`;
  }

  words(): readonly string[] {
    return [...this.#words];
  }
}

/** Строка только в объекте: текст отказа её не называет. */
class Unsaid implements Hint {
  readonly #words: readonly string[];

  constructor(words: readonly string[]) {
    this.#words = words;
  }

  said(): string {
    return "";
  }

  reason(own: string): string {
    return own;
  }

  words(): readonly string[] {
    return [...this.#words];
  }
}

/**
 * Слова адреса без корня. Адрес до приёмника — путь, варианты и вход,
 * значений с пробелом в нём нет, поэтому слова и текст сходятся.
 */
function addressWords(address: string): string[] {
  return address.split(" ").slice(1);
}

/**
 * Готовая строка по адресу приёмника: за адресом — слова `words` от слов
 * ключевого сообщения (`scene.taken`).
 *
 * @param lead связка перед строкой в тексте (`: `, `; причина: `)
 * @param reason вид отказа, если его называет подсказка, а не отказ
 */
export function atAddress(
  lead: string,
  words: (taken: readonly string[]) => readonly string[],
  reason?: string,
): Remedy {
  return {
    hint: (scene) =>
      new Spelled(
        lead,
        [...addressWords(scene.address), ...words(scene.taken)],
        reason,
      ),
  };
}

/** Готовая строка целиком, от корня: слова известны отказывающему. */
export function wholeLine(lead: string, words: readonly string[]): Remedy {
  return { hint: () => new Spelled(lead, words) };
}

/** Строка, набранная через вход `gate`: вход — первым словом строки. */
export function throughGate(lead: string, gate: string): Remedy {
  return { hint: (scene) => new Spelled(lead, [gate, ...scene.line]) };
}

/**
 * Ближайшее вместо непонятого: в сообщении, которому отказали, слово
 * селектора заменено ближайшим, прочие слова строки — как набраны. У
 * ключевого селектора заменяется каждое ключевое слово по порядку.
 * Ближайших не одно — подсказать нечего.
 */
export function nearestOf(
  selector: string,
  candidates: readonly string[],
): Remedy {
  if (candidates.length !== 1) return NO_REMEDY;
  const [candidate] = candidates;
  return {
    hint(scene) {
      const message = scene.line.slice(scene.start, scene.end);
      const replaced = replacedParts(
        message,
        parts(selector),
        parts(candidate),
      );
      if (replaced === undefined) return NO_HINT;
      return new Unsaid([
        ...scene.line.slice(0, scene.start),
        ...replaced,
        ...scene.line.slice(scene.end),
      ]);
    },
  };
}

/**
 * Слова, которым отказали, заменены словами `words`; прочие слова строки
 * — как набраны. Текст отказа строку не называет.
 */
export function substituted(words: readonly string[]): Remedy {
  return {
    hint: (scene) =>
      new Unsaid([
        ...scene.line.slice(0, scene.start),
        ...words,
        ...scene.line.slice(scene.end),
      ]),
  };
}

/** Слова селектора, как их набирают: `id:text:` → `id:`, `text:`. */
function parts(selector: string): string[] {
  if (!selector.endsWith(":")) return [selector];
  return selector.slice(0, -1).split(":").map((part) => `${part}:`);
}

/**
 * Слова сообщения, где части селектора `from` по порядку заменены частями
 * `to`; частей разное число или часть не нашлась — `undefined`.
 */
function replacedParts(
  message: readonly string[],
  from: readonly string[],
  to: readonly string[],
): string[] | undefined {
  if (from.length !== to.length) return undefined;
  const out = [...message];
  let at = 0;
  for (const [i, part] of from.entries()) {
    const found = out.indexOf(part, at);
    if (found < 0) return undefined;
    out[found] = to[i];
    at = found + 1;
  }
  return out;
}
