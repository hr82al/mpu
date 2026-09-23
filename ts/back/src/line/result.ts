/**
 * Результат команды после закрытия (`platform/line-grammar.md` [D.5]):
 * его методы — форматы, которые объявила команда. Выбор формата ничего не
 * исполняет: неизвестный формат отказывает до исполнения, а исполнение —
 * конец строки.
 */

import { GRAMMAR } from "../messages/mod.ts";
import {
  AsideCall,
  type Call,
  type Closing,
  type Data,
  type Doc,
  type Fallback,
  gate,
  isSelection,
  type Named,
  type Outcome,
  type Receiver,
  Refusal,
  type Report,
  type ResultKind,
  selectable,
  selecting,
  selectionOf,
  type Sent,
  Shape,
  type Source,
} from "../objects/mod.ts";
import type { Line } from "./dispatch.ts";
import { formatted, type Order } from "./order.ts";

/** Как исполнить строку в конце: взгляд и правила знает дерево. */
export type Settle = (
  report: Report,
  line: Line,
  order: Order,
) => Promise<Outcome>;

/** Исполнение строки глазами результата: печать, поток, отбор. */
export interface Execution {
  settle(report: Report, line: Line, order: Order): Promise<Outcome>;
  /** Результат строки — поток. */
  streams(line: Line, order: Order): boolean;
  /** Исполнение, результат которого данными уходит отбору `replay`. */
  select(
    report: Report,
    line: Line,
    order: Order,
    replay: (data: Data) => Promise<Outcome>,
  ): Promise<Outcome>;
}

/** Строка к исполнению и то, как её соберут для диспетчеризации. */
export class Pending {
  readonly #line: Line;
  readonly #order: Order;

  constructor(line: Line, order: Order) {
    this.#line = line;
    this.#order = order;
  }

  /** Та же строка с форматом, выбранным словами прежнего флага. */
  as(words: readonly string[]): Pending {
    return new Pending(this.#line, formatted(this.#order, words));
  }

  settle(report: Report, settle: Settle): Promise<Outcome> {
    return settle(report, this.#line, this.#order);
  }

  /**
   * Строка — источником отбора. Поток отбору не подлежит: отказ тут
   * же, до исполнения.
   */
  source(execution: Execution): Source {
    if (execution.streams(this.#line, this.#order)) {
      throw new Refusal("поток — только форматы");
    }
    return {
      select: (report, replay) =>
        execution.select(report, this.#line, this.#order, replay),
    };
  }
}

/**
 * Результат команды после закрытия: протокол, отбор, иначе — вид с
 * форматами.
 */
class CommandResult implements Receiver {
  readonly #shape: Shape<Pending>;
  readonly #kind: ResultKind;
  readonly #pending: Pending;
  readonly #execution: Execution;

  constructor(
    shape: Shape<Pending>,
    kind: ResultKind,
    pending: Pending,
    execution: Execution,
  ) {
    this.#shape = shape;
    this.#kind = kind;
    this.#pending = pending;
    this.#execution = execution;
  }

  lookup(sent: Sent): Call {
    const formats = () => this.#shape.lookup(sent, this.#pending);
    return sent.route({
      named: (named) =>
        selectionOf(
          named,
          this.#kind,
          () => this.#pending.source(this.#execution),
          formats,
        ),
      tail: formats,
      close: formats,
    });
  }

  final(report: Report): Promise<Outcome> {
    return this.#shape.end(report, this.#pending);
  }
}

/** Отказ формату, которого у результата нет, — со списком тех, что есть. */
function refusing(names: readonly string[]): Fallback<Pending> {
  return {
    understand(sent): never {
      throw new Refusal(
        `не понимает ${sent.selector()}; есть: ${names.join(", ")}`,
      );
    },
    lines: () => [],
    describe() {},
  };
}

function formatDoc(name: string): Doc {
  return {
    purpose: `результат в формате ${name}`,
    help: `Печатает результат команды в формате ${name}; код завершения ` +
      "тот же, что без формата.",
  };
}

/**
 * Результат команды: форматы (имя → слова прежнего флага), отбор и
 * исполнение в конце строки.
 */
export class ResultOf {
  readonly #names: readonly string[];
  readonly #shape: Shape<Pending>;
  readonly #kind: ResultKind;
  readonly #execution: Execution;
  readonly #doc: Doc;

  /**
   * @param formats форматы результата команды, `json` в их числе
   * @param execution исполнение строки в конце: печатью или отбором
   */
  constructor(
    formats: Readonly<Record<string, readonly string[]>>,
    execution: Execution,
  ) {
    const names = Object.keys(formats).sort();
    const settle = execution.settle.bind(execution);
    const ending = {
      finish: (report: Report, pending: Pending) =>
        pending.settle(report, settle),
    };
    // Формат выбран — выбирать нечего: следующее слово — отказ.
    const chosen = new Shape<Pending>([], { ending });
    this.#names = names;
    this.#shape = new Shape<Pending>(
      names.map((name) =>
        gate(
          name,
          formatDoc(name),
          chosen,
          (pending) => pending.as(formats[name]),
        )
      ),
      { fallback: refusing(names), ending },
    );
    this.#kind = selectable(this.#shape);
    this.#execution = execution;
    this.#doc = {
      purpose: "результат команды",
      help: `Слово после ${GRAMMAR.close} — формат результата: ` +
        `${names.join(", ")} — или сообщение отбора. Без формата — вид по ` +
        "умолчанию.",
    };
  }

  /** Имена форматов по алфавиту. */
  names(): readonly string[] {
    return this.#names;
  }

  /** Понимает ли результат ключевое сообщение `selector` отбором. */
  selects(selector: string): boolean {
    return isSelection(selector);
  }

  /**
   * Сообщение отбора `named` результату строки `pending` — без закрытия,
   * сразу за командой.
   */
  select(pending: Pending, named: Named): Call {
    return selecting(pending.source(this.#execution), named);
  }

  /**
   * Закрытие вида с состоянием `S`: строку к исполнению даёт `pending`.
   *
   * @param pending строка к исполнению из состояния вида
   */
  closing<S>(pending: (self: S) => Pending): Closing<S> {
    return {
      close: (self) =>
        new AsideCall(
          GRAMMAR.close,
          this.#doc,
          this.#kind,
          () =>
            new CommandResult(
              this.#shape,
              this.#kind,
              pending(self),
              this.#execution,
            ),
        ),
      formats: () => this.#names,
    };
  }
}
