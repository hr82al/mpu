/**
 * Приёмник глазами разбора: какие ключи он знает, какого они вида и в
 * какие ключевые методы складываются. Существует ли унарный селектор,
 * разбор не спрашивает — непонятое решает сам приёмник.
 */

import { type Message, MessageParseError } from "./message.ts";

/** Вид ключа в описании приёмника. */
export type KeyKind = "value" | "flag";

/** Ключевой метод приёмника: его ключи с видом и обязательные из них. */
export interface KeywordMethod {
  readonly keys: Readonly<Record<string, KeyKind>>;
  readonly required: readonly string[];
}

/**
 * Что приёмник объявил: унарные селекторы, ключевые методы и, если есть,
 * имя вида звена хвоста — остатка строки, который приёмник забирает
 * целиком.
 */
export interface ReceiverDescription {
  readonly unary: readonly string[];
  readonly keyword: readonly KeywordMethod[];
  readonly tail?: string;
}

/** Откуда ключ, ждущий значения, берёт следующее слово. */
export interface ValueSource {
  valueFor(key: string): string;
}

/** Вид ключа: как из слова строки получается значение. */
export interface Kind {
  /** Значение записано текстом: `ключ: текст` или `--ключ=текст`. */
  fromText(key: string, text: string): string | boolean;
  /** Форма `--ключ` без `=`. */
  bare(key: string, source: ValueSource): string | boolean;
}

const VALUE: Kind = {
  fromText: (_key, text) => text,
  bare: (key, source) => source.valueFor(key),
};

const FLAG_TEXTS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["false", false],
]);

const FLAG: Kind = {
  fromText(key, text) {
    const flag = FLAG_TEXTS.get(text);
    if (flag === undefined) {
      throw new MessageParseError(`ключ ${key} ждёт true или false`);
    }
    return flag;
  },
  bare: () => true,
};

const KINDS: Readonly<Record<KeyKind, Kind>> = { value: VALUE, flag: FLAG };

/** Набор пар одного ключевого сообщения. */
class Pairs {
  readonly #values = new Map<string, string | boolean>();

  names(): string[] {
    return [...this.#values.keys()];
  }

  /** Записывает ключ; значение читается, только если ключ новый. */
  take(key: string, kind: Kind, read: (kind: Kind) => string | boolean) {
    if (this.#values.has(key)) {
      throw new MessageParseError(`ключ ${key} указан дважды`);
    }
    this.#values.set(key, read(kind));
  }

  message(): Message {
    return { keyword: Object.fromEntries(this.#values) };
  }
}

/** Ключевой метод, собранный из описания. */
class Method {
  readonly #keys: ReadonlySet<string>;
  readonly #required: readonly string[];

  constructor(description: KeywordMethod) {
    this.#keys = new Set(Object.keys(description.keys));
    this.#required = description.required;
  }

  has(keys: readonly string[]): boolean {
    return keys.every((key) => this.#keys.has(key));
  }

  /** Обязательные ключи, которых нет среди набранных, по алфавиту. */
  missing(keys: readonly string[]): string[] {
    return this.#required.filter((key) => !keys.includes(key)).sort();
  }
}

/** Ключевое сообщение, пока оно набирается. */
export interface Draft {
  /** Входит ли ключ в это сообщение. */
  accepts(key: string): boolean;
  /** Добавляет ключ; значение читает `read` по виду ключа. */
  take(key: string, read: (kind: Kind) => string | boolean): void;
  /** Готовое сообщение либо ошибка недостающего ключа. */
  finish(): Message;
}

/** Сообщение, первый ключ которого знает хотя бы один метод. */
class KnownDraft implements Draft {
  readonly #pairs = new Pairs();
  readonly #methods: readonly Method[];
  readonly #receiver: Receiver;

  constructor(methods: readonly Method[], receiver: Receiver) {
    this.#methods = methods;
    this.#receiver = receiver;
  }

  accepts(key: string): boolean {
    const keys = [...this.#pairs.names(), key];
    return this.#methods.some((method) => method.has(keys));
  }

  take(key: string, read: (kind: Kind) => string | boolean) {
    this.#pairs.take(key, this.#receiver.kindOf(key), read);
  }

  finish(): Message {
    const keys = this.#pairs.names();
    const shortfalls = this.#methods
      .filter((method) => method.has(keys))
      .map((method) => method.missing(keys));
    // Методов с этим набором не меньше одного: каждый ключ вошёл в
    // сообщение только потому, что такой метод нашёлся (`accepts`).
    const fewest = shortfalls.reduce((best, next) =>
      next.length < best.length ? next : best
    );
    if (fewest.length > 0) {
      throw new MessageParseError(`не хватает ключа ${fewest[0]}`);
    }
    return this.#pairs.message();
  }
}

/** Сообщение из ключей, которых приёмник не знает: решать ему самому. */
class LooseDraft implements Draft {
  readonly #pairs = new Pairs();
  readonly #receiver: Receiver;

  constructor(receiver: Receiver) {
    this.#receiver = receiver;
  }

  accepts(): boolean {
    return true;
  }

  take(key: string, read: (kind: Kind) => string | boolean) {
    this.#pairs.take(key, this.#receiver.kindOf(key), read);
  }

  finish(): Message {
    return this.#pairs.message();
  }
}

/** Описание приёмника, проверенное и готовое отвечать разбору. */
export class Receiver {
  readonly #methods: readonly Method[];
  readonly #kinds = new Map<string, Kind>();

  /** @throws MessageParseError ключ объявлен с двумя видами */
  constructor(description: ReceiverDescription) {
    this.#methods = description.keyword.map((method) => new Method(method));
    for (const method of description.keyword) {
      for (const [key, name] of Object.entries(method.keys)) {
        this.#declare(key, KINDS[name]);
      }
    }
  }

  #declare(key: string, kind: Kind) {
    const known = this.#kinds.get(key) ?? kind;
    if (known !== kind) {
      throw new MessageParseError(
        `у ключа ${key} в описании приёмника два вида`,
      );
    }
    this.#kinds.set(key, kind);
  }

  /** Вид ключа; ключ, которого нет ни у одного метода, берёт значение. */
  kindOf(key: string): Kind {
    return this.#kinds.get(key) ?? VALUE;
  }

  /** Черновик сообщения, которое начинается ключом `key`. */
  draft(key: string): Draft {
    const known = this.#methods.some((method) => method.has([key]));
    return known ? new KnownDraft(this.#methods, this) : new LooseDraft(this);
  }
}
