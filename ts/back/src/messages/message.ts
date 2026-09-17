/**
 * Сообщение: унарное — одно слово, ключевое — пары «ключ → значение»
 * в порядке строки, хвост — остаток строки как есть.
 */
export type Message =
  | { readonly unary: string }
  | { readonly keyword: Readonly<Record<string, string | boolean>> }
  | { readonly tail: readonly string[] };

/**
 * Слова строки не складываются в сообщение. Текст — из спеки дословно;
 * имя ключа в нём без двоеточия и без `--`.
 */
export class MessageParseError extends Error {
  override name = "MessageParseError";

  /** Ключ ждёт значения, а за ним ничего подходящего нет. */
  static noValue(key: string): MessageParseError {
    return new MessageParseError(`у ключа ${key} нет значения`);
  }
}
