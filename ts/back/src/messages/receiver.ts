/**
 * Приёмник глазами разбора: какие ключи он знает, какого они вида и в
 * какие ключевые методы складываются. Существует ли унарный селектор,
 * разбор не спрашивает — непонятое решает сам приёмник.
 */

import { type KeyValue, type Message, MessageParseError } from "./message.ts";

/**
 * Вид ключа в описании приёмника: значение, флаг или список — ключ,
 * который можно повторять, значения копятся по порядку.
 */
export type KeyKind = "value" | "flag" | "list";

/** Ключевой метод приёмника: его ключи с видом и обязательные из них. */
export interface KeywordMethod {
  readonly keys: Readonly<Record<string, KeyKind>>;
  readonly required: readonly string[];
  /** Назначения ключей для справки; разбор их не читает. */
  readonly purposes?: Readonly<Record<string, string>>;
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
  /**
   * Хвост ловит только голые значения: ключ его не начинает, даже
   * незнакомый, — он входит в ключевое сообщение (лист ключевой команды).
   */
  readonly values?: true;
  /**
   * Ключи, которые разбор читает флагом, хотя ни один метод их не
   * принимает: приёмник откажет им сам, но слово за ними — не их
   * значение (`--md` у ключевой команды).
   */
  readonly flags?: readonly string[];
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
  /**
   * Значение ключа с новым словом: у списка — дописано, у прочих повтор
   * ключа — ошибка.
   */
  join(
    key: string,
    before: KeyValue | undefined,
    value: string | boolean,
  ): KeyValue;
}

/** Повтор ключа, который не список. */
function once(
  key: string,
  before: KeyValue | undefined,
  value: string | boolean,
): KeyValue {
  if (before !== undefined) {
    throw new MessageParseError(`ключ ${key} указан дважды`);
  }
  return value;
}

const VALUE: Kind = {
  fromText: (_key, text) => text,
  bare: (key, source) => source.valueFor(key),
  join: once,
};

/** Значения ключа-списка до нового слова: первое слово — пусто. */
function valuesOf(before: KeyValue | undefined): readonly string[] {
  return Array.isArray(before) ? before : [];
}

/** Ключ-список: значения копятся по порядку строки. */
const LIST: Kind = {
  fromText: (_key, text) => text,
  bare: (key, source) => source.valueFor(key),
  join: (_key, before, value) => [...valuesOf(before), String(value)],
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
  join: once,
};

const KINDS: Readonly<Record<KeyKind, Kind>> = {
  value: VALUE,
  flag: FLAG,
  list: LIST,
};

/** Набор пар одного ключевого сообщения. */
class Pairs {
  readonly #values = new Map<string, KeyValue>();

  names(): string[] {
    return [...this.#values.keys()];
  }

  /** Записывает ключ: повтор решает вид ключа (`Kind.join`). */
  take(key: string, kind: Kind, read: (kind: Kind) => string | boolean) {
    this.#values.set(key, kind.join(key, this.#values.get(key), read(kind)));
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
  readonly #values: boolean;

  /** @throws MessageParseError ключ объявлен с двумя видами */
  constructor(description: ReceiverDescription) {
    this.#methods = description.keyword.map((method) => new Method(method));
    this.#values = description.values === true;
    for (const method of description.keyword) {
      for (const [key, name] of Object.entries(method.keys)) {
        this.#declare(key, KINDS[name]);
      }
    }
    for (const key of description.flags ?? []) this.#declare(key, FLAG);
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

  /**
   * Начинает ли ключ `key` хвост: незнакомый — да, если хвост берёт не
   * только голые значения.
   */
  opensTailWith(key: string): boolean {
    return !this.#values && !this.#methods.some((method) => method.has([key]));
  }

  /** Черновик ключевого сообщения. */
  draft(): Draft {
    return new Draft(this.#methods, this);
  }
}
