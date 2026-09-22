/**
 * Результат команды после закрытия (`platform/line-grammar.md` [D.5]):
 * его методы — форматы, которые объявила команда. Выбор формата ничего не
 * исполняет: неизвестный формат отказывает до исполнения, а исполнение —
 * конец строки.
 */

import { GRAMMAR } from "../messages/mod.ts";
import {
  AsideCall,
  type Closing,
  type Doc,
  type Fallback,
  gate,
  type Outcome,
  Refusal,
  type Report,
  Shape,
} from "../objects/mod.ts";
import type { Line } from "./dispatch.ts";
import { formatted, type Order } from "./order.ts";

/** Как исполнить строку в конце: взгляд и правила знает дерево. */
export type Settle = (
  report: Report,
  line: Line,
  order: Order,
) => Promise<Outcome>;

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
 * Результат команды: форматы (имя → слова прежнего флага) и исполнение в
 * конце строки.
 */
export class ResultOf {
  readonly #names: readonly string[];
  readonly #shape: Shape<Pending>;
  readonly #doc: Doc;

  /**
   * @param formats форматы результата команды, `json` в их числе
   * @param settle исполнение строки в конце
   */
  constructor(
    formats: Readonly<Record<string, readonly string[]>>,
    settle: Settle,
  ) {
    const names = Object.keys(formats).sort();
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
    this.#doc = {
      purpose: "результат команды",
      help: `Слово после ${GRAMMAR.close} — формат результата: ` +
        `${names.join(", ")}. Без формата — вид по умолчанию.`,
    };
  }

  /** Имена форматов по алфавиту. */
  names(): readonly string[] {
    return this.#names;
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
          this.#shape,
          () => this.#shape.receive(pending(self)),
        ),
      formats: () => this.#names,
    };
  }
}
