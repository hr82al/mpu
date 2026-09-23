/**
 * Значение ключа как выражение (`platform/value-expression.md`): на месте
 * значения — литерал, группа `do … end` или `stdin`. Группа и `stdin`
 * вычисляются до ключевого сообщения; приёмник видит уже значения.
 * Каждое значение разбора — объект: как оно вычисляется, решает оно само.
 */

import { GRAMMAR } from "./grammar.ts";
import { type KeyValue, type Message, MessageParseError } from "./message.ts";

/** Где вычисляются значения: у исполнителя строки. */
export interface Evaluation {
  /** Результат группы — значением ключа `key`. */
  group(words: readonly string[], key: string): Promise<string>;
  /** stdin строки — значением ключа `key`; не задаётся — `undefined`. */
  stdin(key: string): Promise<string | undefined>;
}

/** Значение ключа в разборе. */
export interface Value {
  /** Значение для приёмника; `undefined` — ключ остаётся без значения. */
  settle(evaluation: Evaluation, key: string): Promise<KeyValue | undefined>;
  /** Значение ключа-флага из того, что записано. */
  asFlag(key: string): Value;
  /** Значения ключа-списка: это и следующее. */
  append(next: Value): Value;
  /** Как значение записано в строке. */
  text(): string;
}

const FLAG_TEXTS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["false", false],
]);

/** Флаг: `true` или `false`. */
export class Flag implements Value {
  readonly #on: boolean;

  constructor(on: boolean) {
    this.#on = on;
  }

  settle(): Promise<boolean> {
    return Promise.resolve(this.#on);
  }

  asFlag(): Value {
    return this;
  }

  append(next: Value): Value {
    return new ListValue([this, next]);
  }

  text(): string {
    return String(this.#on);
  }
}

/** Текст, записанный в строке. */
export class Literal implements Value {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  settle(): Promise<string> {
    return Promise.resolve(this.#text);
  }

  asFlag(key: string): Value {
    const on = FLAG_TEXTS.get(this.#text);
    if (on === undefined) {
      throw new MessageParseError(`ключ ${key} ждёт true или false`);
    }
    return new Flag(on);
  }

  append(next: Value): Value {
    return new ListValue([this, next]);
  }

  text(): string {
    return this.#text;
  }
}

/** Выражение на месте значения флагом быть не может. */
function notFlag(key: string): never {
  throw new MessageParseError(`ключ ${key} ждёт true или false`);
}

/** Группа `do … end` на месте значения: её результат. */
export class GroupValue implements Value {
  readonly #words: readonly string[];

  constructor(words: readonly string[]) {
    this.#words = [...words];
  }

  settle(evaluation: Evaluation, key: string): Promise<string> {
    return evaluation.group(this.#words, key);
  }

  asFlag(key: string): Value {
    return notFlag(key);
  }

  append(next: Value): Value {
    return new ListValue([this, next]);
  }

  text(): string {
    return [GRAMMAR.open, ...this.#words, GRAMMAR.close].join(" ");
  }
}

/** `stdin` на месте значения: весь ввод строки. */
export class StdinValue implements Value {
  settle(evaluation: Evaluation, key: string): Promise<string | undefined> {
    return evaluation.stdin(key);
  }

  asFlag(key: string): Value {
    return notFlag(key);
  }

  append(next: Value): Value {
    return new ListValue([this, next]);
  }

  text(): string {
    return GRAMMAR.stdin;
  }
}

/** Значения ключа-списка по порядку строки. */
export class ListValue implements Value {
  readonly #parts: readonly Value[];

  constructor(parts: readonly Value[]) {
    this.#parts = [...parts];
  }

  append(next: Value): Value {
    return new ListValue([...this.#parts, next]);
  }

  async settle(evaluation: Evaluation, key: string): Promise<string[]> {
    const values: string[] = [];
    for (const part of this.#parts) {
      const got = await part.settle(evaluation, key);
      if (got !== undefined) values.push(String(got));
    }
    return values;
  }

  asFlag(key: string): Value {
    return notFlag(key);
  }

  text(): string {
    return this.#parts.map((part) => part.text()).join(" ");
  }
}

/** Сообщение разбора: ключевое — со значениями разбора. */
export type ParsedMessage =
  | Exclude<Message, { readonly keyword: unknown }>
  | { readonly keyword: Readonly<Record<string, Value>> };

/**
 * Сообщение с вычисленными значениями, по порядку строки. Сообщение без
 * ключей — как есть.
 *
 * @param message сообщение разбора
 * @param evaluation где вычисляются группы и `stdin`
 */
export async function resolvedMessage(
  message: ParsedMessage,
  evaluation: Evaluation,
): Promise<Message> {
  if (!("keyword" in message)) return message;
  const keyword: Record<string, KeyValue> = {};
  for (const [key, value] of Object.entries(message.keyword)) {
    const got = await value.settle(evaluation, key);
    if (got !== undefined) keyword[key] = got;
  }
  return { keyword };
}
