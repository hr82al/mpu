/**
 * Строка определения метода словами (`platform/image.md`,
 * «Определение»): `<получатель> define: <имя> purpose: ^…^ [keys: ^…^]
 * do … done`. Её пишет строка `define:` и файл метода каталога образа
 * (`image-sync.md`, «Файл метода») — разбор один на обоих.
 */

import { GRAMMAR } from "../messages/mod.ts";

/** Сообщение определения метода. */
export const DEFINE = "define:";
/** Ключ назначения — обязателен. */
export const PURPOSE = "purpose:";
/** Ключ описания ключей для справки. */
const KEYS = "keys:";

/** Слова грамматики: получателем они не бывают. */
const GRAMMAR_WORDS: ReadonlySet<string> = new Set(Object.values(GRAMMAR));

/** Голое слово: начало строки до сообщения образа. */
export function isPlain(word: string): boolean {
  return !word.endsWith(":") && !/^[-^@:]/.test(word) &&
    !GRAMMAR_WORDS.has(word);
}

/** Значение ключа определения: `^текст^` или одно слово; позиция за ним. */
function valueAt(
  words: readonly string[],
  at: number,
): { readonly text: string; readonly next: number } | undefined {
  const word = words[at];
  if (word === undefined) return undefined;
  if (!word.startsWith(GRAMMAR.quote)) return { text: word, next: at + 1 };
  const end = words.findIndex((one, i) =>
    i >= at && (i > at || one.length > 1) && one.endsWith(GRAMMAR.quote)
  );
  if (end < 0) return undefined;
  const text = words.slice(at, end + 1).join(" ");
  return {
    text: text.slice(GRAMMAR.quote.length, -GRAMMAR.quote.length),
    next: end + 1,
  };
}

/** Что сказано в строке определения до тела. */
export interface Said {
  /** Назначение; не сказано — `undefined` (отказ решает `define:`). */
  readonly purpose: string | undefined;
  readonly keys: string;
  /** Начало тела в словах после `define:` (имя — слово 0). */
  readonly body: number;
  /** Ключ, чей текст не закрыт; всё закрыто — `undefined`. */
  readonly unclosed: string | undefined;
}

/**
 * Назначение и описание ключей до тела; повтор — побеждает последний.
 *
 * @param rest слова после `define:`: имя, ключи, тело
 */
export function saidOf(rest: readonly string[]): Said {
  let purpose: string | undefined;
  let keys = "";
  let at = 1;
  for (;;) {
    const key = rest[at];
    if (key !== PURPOSE && key !== KEYS) break;
    const value = valueAt(rest, at + 1);
    if (value === undefined) return { purpose, keys, body: at, unclosed: key };
    if (key === PURPOSE) purpose = value.text;
    else keys = value.text;
    at = value.next;
  }
  return { purpose, keys, body: at, unclosed: undefined };
}

/**
 * Имя, как оно хранится: `cardsIn` ≡ `cardsIn:`; с двоеточием или с
 * параметрами — каждая часть с двоеточием, иначе унарное как написано.
 * Проверок нет — их делает `define:`.
 */
export function storedName(written: string, params: number): string {
  if (!written.includes(":") && params === 0) return written;
  return written.split(":").filter((part) => part !== "")
    .map((part) => `${part}:`).join("");
}
