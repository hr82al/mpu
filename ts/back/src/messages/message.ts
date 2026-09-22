/**
 * Сообщение: унарное — одно слово, ключевое — пары «ключ → значение»
 * в порядке строки, хвост — остаток строки до закрытия, закрытие — слово
 * `end`: всё до него — выражение, следующее слово — сообщение его
 * результату (`platform/line-grammar.md`).
 */
export type Message =
  | { readonly unary: string }
  | { readonly keyword: Readonly<Record<string, string | boolean>> }
  | { readonly tail: readonly string[]; readonly foreign?: true }
  | { readonly close: true };

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

/**
 * За значением ключа — слово, которое не ключ и не закрытие. Подсказку,
 * как надо, дописывает тот, кто знает адрес строки и её приёмник.
 */
export class StrayWord extends MessageParseError {
  override name = "StrayWord";
  /** Значение, за которым стоит слово. */
  readonly value: string;
  /** Слово, которое значению не понятно. */
  readonly word: string;
  /** Слова ключевого сообщения до этого слова, как в строке. */
  readonly taken: readonly string[];

  constructor(value: string, word: string, taken: readonly string[]) {
    super(`значение ${value} не понимает ${word}`);
    this.value = value;
    this.word = word;
    this.taken = [...taken];
  }
}
