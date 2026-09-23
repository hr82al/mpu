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
  type Named,
  type Outcome,
  type Receiver,
  type Reflection,
  type Report,
  type ResultKind,
  type Sent,
  type Shown,
} from "./protocol.ts";
import { Refusal } from "./refusal.ts";
import { NO_REMEDY } from "./remedy.ts";
import { SILENT } from "./silent.ts";

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
export function jsonText(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** `json`: данные объектом; у данных со своим видом — их данные. */
const JSON_PRINTER: Printer = {
  present: (data, report) => report.value(jsonText(data)),
  show: (item, report) => report.value(jsonText(item.data())),
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

/** Отражение данных: сообщений нет, результат понимает форматы данных. */
export const DATA_REFLECTION: Reflection = {
  ...SILENT,
  formats: () => [...DATA_FORMATS],
};

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

/** Что результат после закрытия делает со словом, которое не формат. */
export interface ResultEnd {
  /** Вид результата: разбор следующего слова, справка, отражение. */
  readonly kind: ResultKind;
  /** Сообщение данным `inner`, не формат. */
  selects(inner: Receiver, named: Named): Call;
}

/** Слово, которое не формат, — отказ со списком форматов. */
function formatsOnly(selector: string): never {
  const names = DATA_FORMATS.join(", ");
  throw new Refusal(`не понимает ${selector}; есть: ${names}`);
}

/**
 * Закрытое выражение с выбранной печатью: формат — сообщение ему,
 * прочее слово решает конец результата, второе закрытие — результат
 * этого результата.
 */
class Printed implements Receiver {
  readonly #inner: Receiver;
  readonly #printer: Printer;
  readonly #end: ResultEnd;

  constructor(inner: Receiver, printer: Printer, end: ResultEnd) {
    this.#inner = inner;
    this.#printer = printer;
    this.#end = end;
  }

  lookup(sent: Sent): Call {
    return sent.route({
      named: (named) =>
        this.#format(named.selector(), named.text()) ??
          this.#end.selects(this.#inner, named),
      tail: () => formatsOnly(sent.selector()),
      close: () => endOf(this),
    });
  }

  final(report: Report): Promise<Outcome> {
    return this.#inner.final(printing(report, this.#printer));
  }

  /** Формат выбран: дальше — только закрытие. */
  #format(selector: string, text: string): Call | undefined {
    const format = FORMATS.get(selector);
    if (format === undefined) return undefined;
    const [doc, printer] = format;
    const next = new Printed(this.#inner, printer, FORMATS_ONLY);
    return new AsideCall(text, doc, PRINTED, () => next);
  }
}

/** Вид результата данных: разбор, справка, подсказки. */
export const PRINTED: ResultKind = {
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
  remedy: () => NO_REMEDY,
  reflect: () => ({
    ...DATA_REFLECTION,
    messages: () =>
      [...FORMATS].map(([selector, [format]]) => ({
        selector,
        kind: "unary" as const,
        purpose: format.purpose,
      })),
    understands: (selector) => FORMATS.has(selector),
  }),
};

/** Результат с одними форматами: прочее слово — отказ. */
const FORMATS_ONLY: ResultEnd = {
  kind: PRINTED,
  selects: (_inner, named) => formatsOnly(named.selector()),
};

/**
 * Закрытие выражения, которое кончается данными: результат с форматами.
 *
 * @param end что результат делает со словом, которое не формат
 */
export function endOf(receiver: Receiver, end = FORMATS_ONLY): Call {
  return new AsideCall(
    GRAMMAR.close,
    RESULT_DOC,
    end.kind,
    () => new Printed(receiver, AS_IS, end),
  );
}

/**
 * Сообщение приёмнику-данным: сообщений он не понимает, закрытие делает
 * из него результат с форматами.
 *
 * @param end что результат делает со словом, которое не формат
 */
export function ended(
  receiver: Receiver,
  sent: Sent,
  end = FORMATS_ONLY,
): Call {
  const refuse = (): never => {
    throw new Refusal(`цепочка окончена, ${sent.selector()} отправить некому`);
  };
  return sent.route({
    named: refuse,
    tail: refuse,
    close: () => endOf(receiver, end),
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
  remedy: () => NO_REMEDY,
  reflect: () => DATA_REFLECTION,
};

/** Ответ на `help` — объект-справка приёмником. */
export function answered(help: Help): Receiver {
  return new Answered(help);
}
