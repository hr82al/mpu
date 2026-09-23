/**
 * Метод образа в дереве ядра (`platform/image.md`, «Вызов и отражение»):
 * метод вида получателя рядом с его командами. Отвечает протоколу
 * отражения, справке и дополнению как команда; в конце строки — только
 * решение правил пути метода. Тело исполняет программа.
 */

import type { ImageMethod } from "../image/mod.ts";
import type {
  Call,
  Description,
  Doc,
  KeyLine,
  Method,
  Named,
  Outcome,
  Receiver,
  Report,
  ResultKind,
  Trace,
} from "../objects/mod.ts";
import {
  type Help,
  HELP_SELECTOR,
  line as lineText,
  REFUSE,
  ROOT_TEXT,
  Shape,
} from "../objects/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { callWord } from "../program/mod.ts";
import type { Line } from "./dispatch.ts";

/** Что строка делает с вызовом метода в конце: решает правила. */
export type Consent = (report: Report, line: Line) => Promise<Outcome>;

/** Вызов метода: звено пути — имя по порядку частей, а не селектор. */
class ImageCall implements Call {
  readonly #link: string;
  readonly #text: string;
  readonly #doc: Doc;
  readonly #kind: Shape<Line>;
  readonly #line: Line;

  constructor(
    link: string,
    text: string,
    doc: Doc,
    kind: Shape<Line>,
    line: Line,
  ) {
    this.#link = link;
    this.#text = text;
    this.#doc = doc;
    this.#kind = kind;
    this.#line = line;
  }

  trace(trail: Trace) {
    trail.step(this.#link, this.#text);
  }

  result(): ResultKind {
    return this.#kind;
  }

  help(trail: Trace): Help {
    return this.#kind.about(trail.textWith(this.#text), this.#doc);
  }

  perform(): Promise<Receiver> {
    return Promise.resolve(this.#kind.receive(this.#line));
  }
}

/** Метод образа как метод вида. */
class ImageEntry implements Method<Line> {
  readonly selector: string;
  readonly #method: ImageMethod;
  readonly #kind: Shape<Line>;

  constructor(method: ImageMethod, consent: Consent) {
    this.selector = method.selector();
    this.#method = method;
    this.#kind = new Shape<Line>([], {
      ending: { finish: consent },
      fallback: { ...REFUSE, describe: (into) => this.#keys(into, true) },
    });
  }

  describe(into: Description) {
    const parts = this.#method.parts();
    if (parts.length === 0) return into.unary(this.selector);
    this.#keys(into, false);
  }

  /**
   * Ключи метода — части имени; справке — с описанием из `keys:`, списку
   * сообщений — без него: там назначение метода.
   */
  #keys(into: Description, described: boolean) {
    const names = this.#method.parts().map((part) => part.slice(0, -1));
    if (names.length === 0) return;
    const { keys } = this.#method.record();
    into.keyword({
      keys: Object.fromEntries(names.map((name) => [name, "value" as const])),
      required: names,
      ...(described
        ? { purposes: Object.fromEntries(names.map((name) => [name, keys])) }
        : {}),
    });
  }

  line() {
    return {
      selector: this.#method.record().name,
      purpose: this.#method.purposeLine(),
    };
  }

  /**
   * Вызов; значение `help` на месте значения части — справка метода
   * (`kiten cardsIn: help`, `platform/image.md`), а не вызов со словом
   * `help`: иначе справку метода не спросить ничем.
   */
  bind(line: Line, sent: Named): Call {
    const doc = {
      purpose: this.#method.purposeLine(),
      help: this.#method.help(),
    };
    const link = this.#method.record().name;
    const asked = Object.values(sent.args())
      .some((value) => String(value) === HELP_SELECTOR);
    const kind = asked ? this.#helpKind(doc) : this.#kind;
    return new ImageCall(link, sent.text(), doc, kind, line);
  }

  /** Вид, который в конце строки печатает справку метода. */
  #helpKind(doc: Doc): Shape<Line> {
    const help = this.#kind.about(
      lineText(ROOT_TEXT, this.#method.links()),
      doc,
    );
    return new Shape<Line>([], {
      ending: { finish: (report) => Promise.resolve(report.shown(help)) },
    });
  }
}

/**
 * Методы образа получателя `path` — методы его вида.
 *
 * @param consent решение правил вызова в конце строки
 */
export function imageEntries(
  methods: readonly ImageMethod[],
  path: readonly string[],
  consent: Consent,
): Method<Line>[] {
  const receiver = path.join(" ");
  return methods
    .filter((method) => method.record().receiver.join(" ") === receiver)
    .map((method) => new ImageEntry(method, consent));
}

/** Ключи метода глазами отражения (снимок дерева). */
export function imageKeys(method: ImageMethod): KeyLine[] {
  const { keys } = method.record();
  return method.parts().map((part) => ({
    name: part.slice(0, -1),
    kind: "value",
    required: true,
    purpose: keys,
    reason: null,
  }));
}

/**
 * Зовёт ли строка метод образа: получатель и первое слово вызова подряд
 * (не за `--`). Справка метода (`kiten cardsIn: help`) — не вызов: её
 * даёт дерево.
 */
export function callsImage(
  words: readonly string[],
  methods: readonly ImageMethod[],
): boolean {
  if (words.includes(HELP_SELECTOR)) return false;
  return methods.some((method) => {
    const call = [...method.record().receiver, callWord(method.record().name)];
    return words.some((_, at) =>
      words[at - 1] !== GRAMMAR.literal &&
      call.every((word, i) => words[at + i] === word)
    );
  });
}
