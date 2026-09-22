/**
 * Результат выражения после закрытия (`platform/line-grammar.md`): слово
 * после `end` — сообщение результату. У данных результат понимает формат
 * `json`; без формата — вид по умолчанию, прежняя печать данных. Здесь же
 * объект-справка как приёмник: ответ на `help`.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { DATA_VIEW, Help, OBJECT_VIEW } from "./help.ts";
import { AsideCall } from "./method.ts";
import {
  type Call,
  type Doc,
  HELP_SELECTOR,
  type Outcome,
  type Receiver,
  type Report,
  type ResultKind,
  type Sent,
  type Shown,
} from "./protocol.ts";
import { Refusal } from "./refusal.ts";
import { remedyFor } from "./remedy.ts";

/** Как результат отдаёт данные в конце строки. */
interface Printer {
  present(data: unknown, report: Report): Outcome;
  show(item: Shown, report: Report): Outcome;
}

/** Вид по умолчанию: данные как есть — печатает их точка входа. */
const AS_IS: Printer = {
  present: (data, report) => report.value(data),
  show: (item, report) => report.shown(item),
};

/** JSON с отступом 2 и переводом строки в конце. */
function json(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** `json`: данные объектом; у данных со своим видом — их данные. */
const JSON_PRINTER: Printer = {
  present: (data, report) => report.value(json(data)),
  show: (item, report) => report.value(json(item.data())),
};

/** Итог, у которого данные проходят через печать. */
function printing(report: Report, printer: Printer): Report {
  return {
    value: (data) => printer.present(data, report),
    shown: (item) => printer.show(item, report),
    object: () => report.object(),
    exit: (code) => report.exit(code),
    links: () => report.links(),
    text: () => report.text(),
    through: (gate) => report.through(gate),
  };
}

/** Форматы результата данных. */
const FORMATS: ReadonlyMap<string, readonly [Doc, Printer]> = new Map([
  ["json", [{
    purpose: "результат как JSON",
    help: "Данные результата JSON-объектом: отступ 2, перевод строки в конце.",
  }, JSON_PRINTER]],
]);

/** Имена форматов, которые понимает результат данных. */
export const DATA_FORMATS: readonly string[] = [...FORMATS.keys()];

const RESULT_DOC: Doc = {
  purpose: "результат выражения",
  help: `Слово после ${GRAMMAR.close} — формат результата.`,
};

/** Справка метода, отдающего данные. */
export function dataHelp(path: string, doc: Doc): Help {
  return new Help({
    path,
    purpose: doc.purpose,
    text: doc.help,
    examples: [...(doc.examples ?? [])],
    keys: [],
    formats: [...DATA_FORMATS],
    messages: [],
  }, DATA_VIEW);
}

/**
 * Закрытое выражение с выбранной печатью: формат — сообщение ему,
 * непонятое слово — отказ со списком форматов, второе закрытие —
 * результат этого результата.
 */
class Printed implements Receiver {
  readonly #inner: Receiver;
  readonly #printer: Printer;

  constructor(inner: Receiver, printer: Printer) {
    this.#inner = inner;
    this.#printer = printer;
  }

  lookup(sent: Sent): Call {
    const refuse = (): never => {
      const names = DATA_FORMATS.join(", ");
      throw new Refusal(`не понимает ${sent.selector()}; есть: ${names}`);
    };
    return sent.route({
      named: (named) =>
        this.#format(named.selector(), named.text()) ?? refuse(),
      tail: refuse,
      close: () => endOf(this),
    });
  }

  final(report: Report): Promise<Outcome> {
    return this.#inner.final(printing(report, this.#printer));
  }

  #format(selector: string, text: string): Call | undefined {
    const format = FORMATS.get(selector);
    if (format === undefined) return undefined;
    const [doc, printer] = format;
    const next = new Printed(this.#inner, printer);
    return new AsideCall(text, doc, PRINTED, () => next);
  }
}

/** Вид результата данных: разбор, справка, подсказки. */
const PRINTED: ResultKind = {
  parsing: () => ({ unary: [...DATA_FORMATS], keyword: [] }),
  about: (path, doc) =>
    new Help({
      path,
      purpose: doc.purpose,
      text: doc.help,
      examples: [],
      keys: [],
      formats: [...DATA_FORMATS],
      messages: [...FORMATS].map(([selector, [format]]) => ({
        selector,
        purpose: format.purpose,
      })),
    }, OBJECT_VIEW),
  remedy: (word) => remedyFor(word, DATA_FORMATS),
};

/** Закрытие выражения, которое кончается данными: результат с форматами. */
export function endOf(receiver: Receiver): Call {
  return new AsideCall(
    GRAMMAR.close,
    RESULT_DOC,
    PRINTED,
    () => new Printed(receiver, AS_IS),
  );
}

/**
 * Сообщение приёмнику-данным: сообщений он не понимает, закрытие делает
 * из него результат с форматами.
 */
export function ended(receiver: Receiver, sent: Sent): Call {
  const refuse = (): never => {
    throw new Refusal(`цепочка окончена, ${sent.selector()} отправить некому`);
  };
  return sent.route({
    named: refuse,
    tail: refuse,
    close: () => endOf(receiver),
  });
}

/**
 * Объект-справка как приёмник: ничего, кроме закрытия, не понимает —
 * справку просят последним словом (`mpu help kiten` — отказ с готовой
 * строкой `mpu kiten help`).
 */
class Answered implements Receiver {
  readonly #help: Help;

  constructor(help: Help) {
    this.#help = help;
  }

  lookup(sent: Sent): Call {
    const refuse = (words: readonly string[]): never => {
      const call = [this.#help.data().path, ...words, HELP_SELECTOR];
      throw new Refusal(
        `не понимает ${sent.selector()}; справка — последним словом: ` +
          call.join(" "),
      );
    };
    return sent.route({
      named: (named) => refuse([named.text()]),
      tail: () =>
        sent.viaLink({
          word: (word) => refuse([word]),
          words: (words) => refuse(words),
          refuse: () => refuse([sent.selector()]),
        }),
      close: () => endOf(this),
    });
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.shown(this.#help));
  }
}

/** Справка самого ответа на `help`. */
export const HELP_DOC: Doc = {
  purpose: "справка объекта",
  help: `Данные о приёмнике: без формата — текст, ${GRAMMAR.close} json — ` +
    "объект с полями path, purpose, text, examples, keys, formats, messages.",
};

/**
 * Вид ответа на `help`: слова за ним забираются хвостом — ради отказа с
 * готовой строкой, закрытие даёт форматы.
 */
export const ANSWERED: ResultKind = {
  parsing: () => ({ unary: [], keyword: [], tail: "<слово>" }),
  about: (path, doc) => dataHelp(path, doc),
  remedy: (word) => remedyFor(word, DATA_FORMATS),
};

/** Ответ на `help` — объект-справка приёмником. */
export function answered(help: Help): Receiver {
  return new Answered(help);
}
