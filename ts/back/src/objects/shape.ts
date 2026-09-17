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

  final(report: Report): Outcome {
    return report.object();
  }
}

/** Вид объекта с состоянием `S`. */
export class Shape<S> implements Yields<S>, Reflective {
  readonly #methods: ReadonlyMap<string, Method<S>>;
  readonly #fallback: Fallback<S>;

  /**
   * @param methods собственные методы вида
   * @param fallback ответ на непонятое; по умолчанию — отказ
   */
  constructor(methods: readonly Method<S>[], fallback: Fallback<S> = REFUSE) {
    this.#methods = new Map(methods.map((method) => [method.selector, method]));
    this.#fallback = fallback;
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
    return this.#methods.get(selector)?.bind(self, sent) ??
      COMMON.get(selector)?.bind(this, sent) ??
      this.#fallback.understand(sent, self, () => this.#refuse(selector));
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
