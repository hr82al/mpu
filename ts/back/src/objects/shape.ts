/**
 * Вид объекта и сам объект. Вид держит словарь методов, как класс;
 * объект — вид и собственное состояние. Словарь наружу не отдаётся:
 * разбор, справка и рефлексия спрашивают вид сообщениями.
 */

import type { ReceiverDescription } from "../messages/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import {
  keyLines,
  keywordLine,
  reflected,
  sorted,
  spelled,
  withProtocol,
} from "./reflection.ts";
import {
  AsideCall,
  Description,
  type Fallback,
  type Line,
  type Method,
  REFUSE,
} from "./method.ts";
import { Help, type HelpKey, OBJECT_VIEW } from "./help.ts";
import { nearest, order } from "./nearest.ts";
import { NO_REMEDY } from "./remedy.ts";
import type {
  Call,
  Doc,
  KeyLine,
  MessageLine,
  Outcome,
  Receiver,
  Reflection,
  Remedy,
  Report,
  Sent,
  Trace,
  ValueLine,
  Yields,
} from "./protocol.ts";
import { Refusal } from "./refusal.ts";

/** Как объект отвечает на конец строки. */
export interface Ending<S> {
  finish(report: Report, self: S): Promise<Outcome>;
}

/** Умолчание: итог-объект — справка метода, вернувшего объект. */
const DESCRIBE: Ending<unknown> = {
  finish: (report) => Promise.resolve(report.object()),
};

/**
 * Кого из собственных селекторов вид называет в списках: `messages`,
 * `understands:`, раздел «Сообщения» справки, «ближайшие» в отказе.
 * Поиск метода роспись не трогает — неназванный селектор исполняется.
 */
export interface Roster {
  lists(selector: string): boolean;
}

/** Умолчание: вид называет все свои селекторы. */
export const EVERYONE: Roster = { lists: () => true };

/** Как объект отвечает на закрытие выражения (`end`). */
export interface Closing<S> {
  close(self: S, shape: Shape<S>): Call;
  /** Форматы, которые понимает результат после закрытия. */
  formats(): readonly string[];
}

const SAME_DOC: Doc = {
  purpose: "тот же объект",
  help: `Закрытие объект не меняет: слово после ${GRAMMAR.close} — ему же.`,
};

/** Умолчание: закрытие — тот же объект, следующее слово — ему. */
const STAYS: Closing<unknown> = {
  close: (self, shape) =>
    new AsideCall(GRAMMAR.close, SAME_DOC, shape, () => shape.receive(self)),
  formats: () => [],
};

/** Подсказки к слову за значением ключа, которое пришло этому виду. */
export interface Strays {
  remedy(word: string, after: readonly string[]): Remedy;
}

/** Умолчание: подсказать нечего. */
const PLAIN_STRAYS: Strays = { remedy: () => NO_REMEDY };

/** Значения ключей, которые вид предлагает (`candidates: … like: …`). */
export interface Values {
  candidates(key: string, like: string): Promise<ValueLine[]>;
}

/** Умолчание: значений не предлагает. */
export const NO_VALUES: Values = { candidates: () => Promise.resolve([]) };

/** Необязательное в виде: ответ на непонятое, на конец строки, роспись. */
export interface ShapeOptions<S> {
  /** По умолчанию — отказ. */
  readonly fallback?: Fallback<S>;
  /** По умолчанию — справка вернувшего метода. */
  readonly ending?: Ending<S>;
  /** По умолчанию — все собственные селекторы. */
  readonly roster?: Roster;
  /** По умолчанию — тот же объект. */
  readonly closing?: Closing<S>;
  /** По умолчанию — подсказать нечего. */
  readonly strays?: Strays;
  /** По умолчанию — значений ключей нет. */
  readonly values?: Values;
}

/** Объект: вид и состояние. */
class Instance<S> implements Receiver {
  readonly #shape: Shape<S>;
  readonly #self: S;

  constructor(shape: Shape<S>, self: S) {
    this.#shape = shape;
    this.#self = self;
  }

  lookup(sent: Sent): Call {
    return this.#shape.lookup(sent, this.#self);
  }

  final(report: Report): Promise<Outcome> {
    return this.#shape.end(report, this.#self);
  }
}

/** Вид объекта с состоянием `S`. */
export class Shape<S> implements Yields<S> {
  readonly #methods: ReadonlyMap<string, Method<S>>;
  readonly #fallback: Fallback<S>;
  readonly #ending: Ending<S>;
  readonly #roster: Roster;
  readonly #closing: Closing<S>;
  readonly #strays: Strays;
  readonly #values: Values;

  /**
   * @param methods собственные методы вида
   * @param options ответ на непонятое, на конец строки и роспись
   */
  constructor(methods: readonly Method<S>[], options: ShapeOptions<S> = {}) {
    this.#methods = new Map(methods.map((method) => [method.selector, method]));
    this.#fallback = options.fallback ?? REFUSE;
    this.#ending = options.ending ?? DESCRIBE;
    this.#roster = options.roster ?? EVERYONE;
    this.#closing = options.closing ?? STAYS;
    this.#strays = options.strays ?? PLAIN_STRAYS;
    this.#values = options.values ?? NO_VALUES;
  }

  parsing(): ReceiverDescription {
    const into = new Description();
    for (const method of this.#methods.values()) method.describe(into);
    this.#fallback.describe(into);
    return withProtocol(into).build();
  }

  /** Что вид знает о себе: из своих методов, ответа на непонятое, закрытия. */
  reflect(): Reflection {
    return {
      messages: () => this.#messages(),
      keys: () => this.#commandKeys(),
      formats: () => [...this.#closing.formats()],
      candidates: (key, like) => this.#values.candidates(key, like),
      understands: (selector) => this.#understands(selector),
    };
  }

  /**
   * Сообщения, которые вид называет: собственные унарные — словом,
   * ключевые — первым ключом; ключевое сообщение ответа на непонятое —
   * тоже первым ключом.
   */
  #messages(): MessageLine[] {
    const own = this.#listed().map((method): MessageLine => {
      const into = new Description();
      method.describe(into);
      const signature = into.build().keyword[0];
      const line = method.line();
      return signature === undefined
        ? { selector: line.selector, kind: "unary", purpose: line.purpose }
        : keywordLine(signature, line.purpose);
    });
    const fallback = this.#fallbackKeyword().map((one) => keywordLine(one));
    return sorted([...own, ...fallback]);
  }

  /** Ключи ключевого сообщения команды — у ответа на непонятое. */
  #commandKeys(): KeyLine[] {
    return this.#fallbackKeyword().flatMap(keyLines);
  }

  #fallbackKeyword() {
    const into = new Description();
    this.#fallback.describe(into);
    return into.build().keyword;
  }

  #understands(selector: string): boolean {
    if (this.#methods.has(selector)) return this.#roster.lists(selector);
    return this.#messages().some((line) => line.selector === selector) ||
      this.#commandKeys().some((key) =>
        spelled(key.name, key.kind) === selector
      );
  }

  #listed(): Method<S>[] {
    return [...this.#methods.values()]
      .filter((method) => this.#roster.lists(method.selector));
  }

  about(path: string, doc: Doc): Help {
    const messages = [...this.#ownLines(), ...this.#fallback.lines()];
    return new Help({
      path,
      purpose: doc.purpose,
      text: doc.help,
      examples: [...(doc.examples ?? [])],
      keys: this.#keys(),
      formats: [...this.#closing.formats()],
      messages,
    }, OBJECT_VIEW);
  }

  remedy(word: string, after: readonly string[]): Remedy {
    return this.#strays.remedy(word, after);
  }

  /**
   * Ключи ключевых методов, которые вид называет: собственных и ответа на
   * непонятое.
   */
  #keys(): HelpKey[] {
    const into = new Description();
    for (const method of this.#methods.values()) {
      if (this.#roster.lists(method.selector)) method.describe(into);
    }
    this.#fallback.describe(into);
    return into.build().keyword.flatMap((method) =>
      Object.entries(method.keys).map(([name, kind]) => ({
        name,
        kind,
        required: method.required.includes(name),
        purpose: method.purposes?.[name] ?? "",
      }))
    );
  }

  #ownLines(): Line[] {
    return [...this.#methods.values()]
      .filter((method) => this.#roster.lists(method.selector))
      .map((method) => method.line())
      .sort((a, b) => order(a.selector, b.selector));
  }

  receive(self: S): Receiver {
    return new Instance(this, self);
  }

  /**
   * Метод для сообщения: собственный, затем общий, затем ответ вида на
   * непонятое.
   */
  lookup(sent: Sent, self: S): Call {
    const selector = sent.selector();
    const otherwise = () =>
      this.#fallback.understand(sent, self, () => this.#refuse(selector));
    return sent.route({
      named: (named) =>
        this.#methods.get(selector)?.bind(self, named) ??
          reflected(named, this.reflect()) ?? otherwise(),
      tail: otherwise,
      close: () => this.#closing.close(self, this),
    });
  }

  /** Ответ объекта этого вида на конец строки. */
  end(report: Report, self: S): Promise<Outcome> {
    return this.#ending.finish(report, self);
  }

  #refuse(selector: string): never {
    const close = nearest(
      selector,
      this.#messages().map((line) => line.selector),
    );
    const hint = close.length > 0 ? `; ближайшие: ${close.join(", ")}` : "";
    throw new Refusal(`не понимает ${selector}${hint}`);
  }
}

/** Корень цепочки: звена не добавляет, в тексте — `mpu`. */
class Origin<S> implements Call {
  readonly #doc: Doc;
  readonly #shape: Shape<S>;
  readonly #self: S;

  constructor(doc: Doc, shape: Shape<S>, self: S) {
    this.#doc = doc;
    this.#shape = shape;
    this.#self = self;
  }

  trace(trail: Trace) {
    trail.begin(ROOT_TEXT);
  }

  result(): Shape<S> {
    return this.#shape;
  }

  help(trail: Trace): Help {
    return this.#shape.about(trail.textWith(ROOT_TEXT), this.#doc);
  }

  perform(): Promise<Receiver> {
    return Promise.resolve(this.#shape.receive(this.#self));
  }
}

const ROOT_TEXT = "mpu";

/**
 * Корневой объект цепочки.
 *
 * @param doc назначение и справка корня
 * @param shape вид корня
 * @param self состояние корня
 */
export function origin<S>(doc: Doc, shape: Shape<S>, self: S): Call {
  return new Origin(doc, shape, self);
}
