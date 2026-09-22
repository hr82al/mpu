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
 * имя вида звена хвоста — остатка строки, который приёмник забирает до
 * закрытия. Чужой хвост (`foreign`) забирает всё до конца как есть: в нём
 * слова грамматики не толкуются (`ssh`).
 */
export interface ReceiverDescription {
  readonly unary: readonly string[];
  readonly keyword: readonly KeywordMethod[];
  readonly tail?: string;
  readonly foreign?: true;
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

/**
 * Ключевое сообщение, пока оно набирается. Ключи подряд — всегда одно
 * сообщение: деления на сообщения разным приёмникам нет
 * (`platform/line-grammar.md` [D.2]).
 */
export class Draft {
  readonly #pairs = new Pairs();
  readonly #methods: readonly Method[];
  readonly #receiver: Receiver;
  #last: string | boolean = "";

  constructor(methods: readonly Method[], receiver: Receiver) {
    this.#methods = methods;
    this.#receiver = receiver;
  }

  /** Добавляет ключ; значение читает `read` по виду ключа. */
  take(key: string, read: (kind: Kind) => string | boolean) {
    this.#pairs.take(key, this.#receiver.kindOf(key), (kind) => {
      this.#last = read(kind);
      return this.#last;
    });
  }

  /** Значение последней пары текстом: о нём говорит отказ лишнему слову. */
  last(): string {
    return String(this.#last);
  }

  /**
   * Готовое сообщение. Если набор знает хотя бы один метод, недостающий
   * обязательный ключ — ошибка; набор, которого не знает никто, решает
   * сам приёмник.
   */
  finish(): Message {
    const keys = this.#pairs.names();
    const shortfalls = this.#methods
      .filter((method) => method.has(keys))
      .map((method) => method.missing(keys));
    const complete = shortfalls.some((missing) => missing.length === 0);
    if (shortfalls.length === 0 || complete) return this.#pairs.message();
    const fewest = shortfalls.reduce((best, next) =>
      next.length < best.length ? next : best
    );
    throw new MessageParseError(`не хватает ключа ${fewest[0]}`);
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

  /** Черновик ключевого сообщения. */
  draft(): Draft {
    return new Draft(this.#methods, this);
  }
}
