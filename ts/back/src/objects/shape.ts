/**
 * Вид объекта и сам объект. Вид держит словарь методов, как класс;
 * объект — вид и собственное состояние. Словарь наружу не отдаётся:
 * разбор, справка и рефлексия спрашивают вид сообщениями.
 */

import type { ReceiverDescription } from "../messages/mod.ts";
import {
  COMMON,
  COMMON_SELECTORS,
  type Reflective,
  withCommon,
} from "./common.ts";
import {
  Description,
  type Fallback,
  type Line,
  type Method,
  REFUSE,
} from "./method.ts";
import { nearest, order } from "./nearest.ts";
import type {
  Call,
  Doc,
  Outcome,
  Receiver,
  Report,
  Sent,
  Trace,
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

/** Необязательное в виде: ответ на непонятое и на конец строки. */
export interface ShapeOptions<S> {
  /** По умолчанию — отказ. */
  readonly fallback?: Fallback<S>;
  /** По умолчанию — справка вернувшего метода. */
  readonly ending?: Ending<S>;
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
export class Shape<S> implements Yields<S>, Reflective {
  readonly #methods: ReadonlyMap<string, Method<S>>;
  readonly #fallback: Fallback<S>;
  readonly #ending: Ending<S>;

  /**
   * @param methods собственные методы вида
   * @param options ответ на непонятое и на конец строки
   */
  constructor(methods: readonly Method<S>[], options: ShapeOptions<S> = {}) {
    this.#methods = new Map(methods.map((method) => [method.selector, method]));
    this.#fallback = options.fallback ?? REFUSE;
    this.#ending = options.ending ?? DESCRIBE;
  }

  /** Собственные селекторы по алфавиту. */
  selectors(): string[] {
    return [...this.#methods.keys()].sort(order);
  }

  respondsTo(selector: string): boolean {
    return this.#methods.has(selector) || COMMON_SELECTORS.has(selector);
  }

  parsing(): ReceiverDescription {
    const into = new Description();
    for (const method of this.#methods.values()) method.describe(into);
    this.#fallback.describe(into);
    return withCommon(into).build();
  }

  usage(path: string, doc: Doc): string {
    const lines = [...this.#ownLines(), ...this.#fallback.lines()];
    const width = Math.max(...lines.map((line) => line.selector.length)) + 2;
    const messages = lines
      .map((line) => `  ${line.selector.padEnd(width)}${line.purpose}\n`)
      .join("");
    return `Использование: ${path} <сообщение>\n\n${doc.purpose}\n\n` +
      `${doc.help}\n\nСообщения:\n${messages}`;
  }

  #ownLines(): Line[] {
    return [...this.#methods.values()]
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
          COMMON.get(selector)?.bind(this, named) ?? otherwise(),
      tail: otherwise,
    });
  }

  /** Ответ объекта этого вида на конец строки. */
  end(report: Report, self: S): Promise<Outcome> {
    return this.#ending.finish(report, self);
  }

  #refuse(selector: string): never {
    const close = nearest(selector, this.selectors());
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

  help(trail: Trace): string {
    return this.#shape.usage(trail.textWith(ROOT_TEXT), this.#doc);
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
