/**
 * Приёмник глазами разбора: какие ключи он знает, какого они вида и в
 * какие ключевые методы складываются. Существует ли унарный селектор,
 * разбор не спрашивает — непонятое решает сам приёмник.
 */

import { MessageParseError } from "./message.ts";
import {
  Flag,
  ListValue,
  Literal,
  type ParsedMessage,
  type Spelled,
  type Value,
  type Written,
} from "./value.ts";

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
  /**
   * Причины имён ключей вне словаря (`platform/keys-translation.md`) для
   * отражения; разбор их не читает.
   */
  readonly reasons?: Readonly<Record<string, string>>;
  /**
   * Ключи, которые команда при терминале читает сама (`sql`): `stdin` на
   * их месте при терминале оставляет ключ без значения; разбор их не
   * читает.
   */
  readonly prompts?: readonly string[];
  /**
   * Ключи-текст: слово значения берётся как есть, не толкуясь
   * (`platform/at-word-literal.md`, правило 1).
   */
  readonly texts?: readonly string[];
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
  /** Слово значения: литерал, группа, ввод строки. */
  valueFor(key: string): Written;
  /** Слово значения ключа-текста: как есть, кроме `--`, `do`, `stdin`. */
  textFor(key: string): Written;
}

/** Что набрано под ключом: повтор ключа решает она. */
interface Slot {
  /** Ячейка с ещё одним значением того же ключа. */
  add(key: string, value: Value): Slot;
  /** Значение ключа для сообщения. */
  value(): Value;
}

/** Ключ с одним значением: повтор — ошибка. */
class Single implements Slot {
  readonly #value: Value;

  constructor(value: Value) {
    this.#value = value;
  }

  add(key: string): Slot {
    throw new MessageParseError(`ключ ${key} указан дважды`);
  }

  value(): Value {
    return this.#value;
  }
}

/** Ключ-список: значения копятся по порядку строки. */
class Many implements Slot {
  readonly #values: readonly Value[];

  constructor(values: readonly Value[]) {
    this.#values = values;
  }

  add(_key: string, value: Value): Slot {
    return new Many([...this.#values, value]);
  }

  value(): Value {
    return new ListValue(this.#values);
  }
}

/** Вид ключа: как из слова строки получается значение. */
export interface Kind {
  /** Следующее слово строки — значение ключа `key`, прочитанное этим видом. */
  word(key: string, source: ValueSource): Written;
  /** Значение записано в строке: `ключ: …` или `--ключ=текст`. */
  fromText(key: string, value: Written): Spelled;
  /** Форма `--ключ` без `=`. */
  bare(key: string, source: ValueSource): Spelled;
  /** Ячейка первого значения ключа: как она примет повтор. */
  slot(value: Value): Slot;
}

const VALUE: Kind = {
  word: (key, source) => source.valueFor(key),
  fromText: (_key, value) => value,
  bare: (key, source) => source.valueFor(key),
  slot: (value) => new Single(value),
};

const LIST: Kind = {
  word: (key, source) => source.valueFor(key),
  fromText: (_key, value) => value,
  bare: (key, source) => source.valueFor(key),
  slot: (value) => new Many([value]),
};

const FLAG: Kind = {
  word: (key, source) => source.valueFor(key),
  fromText: (key, value) => value.asFlag(key),
  bare: () => new Flag(true),
  slot: (value) => new Single(value),
};

const KINDS: Readonly<Record<KeyKind, Kind>> = {
  value: VALUE,
  flag: FLAG,
  list: LIST,
};

/** Вид `kind`, чьё слово значения — текст как есть. */
function textual(kind: Kind): Kind {
  return {
    word: (key, source) => source.textFor(key),
    fromText: (key, value) => kind.fromText(key, value),
    bare: (key, source) => source.textFor(key),
    slot: (value) => kind.slot(value),
  };
}

/**
 * Виды ключей-текст — константы: `Receiver` сравнивает виды тождеством,
 * и ключ-текст двух методов остаётся одного вида. Флаг текстом не бывает.
 */
const TEXT_KINDS: Readonly<Record<KeyKind, Kind>> = {
  value: textual(VALUE),
  flag: FLAG,
  list: textual(LIST),
};

/** Набор пар одного ключевого сообщения. */
class Pairs {
  readonly #slots = new Map<string, Slot>();

  names(): string[] {
    return [...this.#slots.keys()];
  }

  /** Записывает ключ: повтор решает ячейка его вида (`Kind.slot`). */
  take(key: string, kind: Kind, read: (kind: Kind) => Spelled) {
    const value = read(kind);
    const before = this.#slots.get(key);
    this.#slots.set(
      key,
      before === undefined ? kind.slot(value) : before.add(key, value),
    );
  }

  message(): ParsedMessage {
    const keyword: Record<string, Value> = {};
    for (const [key, slot] of this.#slots) keyword[key] = slot.value();
    return { keyword };
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
  #last: Spelled = new Literal("");

  constructor(methods: readonly Method[], receiver: Receiver) {
    this.#methods = methods;
    this.#receiver = receiver;
  }

  /** Добавляет ключ; значение читает `read` по виду ключа. */
  take(key: string, read: (kind: Kind) => Spelled) {
    this.#pairs.take(key, this.#receiver.kindOf(key), (kind) => {
      this.#last = read(kind);
      return this.#last;
    });
  }

  /** Значение последней пары текстом: о нём говорит отказ лишнему слову. */
  last(): string {
    return this.#last.text();
  }

  /**
   * Готовое сообщение. Если набор знает хотя бы один метод, недостающий
   * обязательный ключ — ошибка; набор, которого не знает никто, решает
   * сам приёмник.
   */
  finish(): ParsedMessage {
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
      const texts = new Set(method.texts);
      for (const [key, name] of Object.entries(method.keys)) {
        this.#declare(key, (texts.has(key) ? TEXT_KINDS : KINDS)[name]);
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
