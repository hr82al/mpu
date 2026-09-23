/**
 * `it` — последний результат вызывающего (`platform/it.md`): `back`
 * помнит результат последней строки каждого вызывающего, `mpu it md`
 * рисует его заново без повторного исполнения.
 */

import type { Command, Keeper } from "../command/mod.ts";
import { type Delivery, jsonOf } from "../entrypoint/mod.ts";
import { flagged, GRAMMAR } from "../messages/mod.ts";
import {
  AsideCall,
  type Call,
  type Doc,
  type Method,
  type Named,
  type Outcome,
  type Receiver,
  Refusal,
  type Report,
  SELECTABLE,
  selectionMessages,
  selectionOf,
  type Sent,
  type Source,
  unary,
  type Yields,
} from "../objects/mod.ts";
import type { Line } from "./dispatch.ts";

/** Память одного вызывающего: прошлый результат его строки. */
export interface Memory extends Keeper {
  /** Прошлый результат приёмником; его нет — `absent`. */
  recall(absent: Receiver): Receiver;
}

/** Нет вызывающего: запоминать некому, вспомнить нечего. */
export const NO_CALLER: Memory = {
  keep() {},
  recall: (absent) => absent,
};

/** Срок, после которого вызывающий без строк забывается: час. */
export const IDLE_MS = 60 * 60 * 1000;

/** Прошлый результат: команда, её результат и аргументы. */
interface Kept {
  readonly command: Command;
  readonly result: unknown;
  readonly argv: readonly string[];
}

/** Запись памяти: прошлый результат и когда вызывающий был последний раз. */
interface Entry {
  readonly kept: Kept | undefined;
  readonly seen: number;
}

/**
 * Результаты вызывающих в памяти `back`: один на вызывающего, после
 * перезапуска — пусто; вызывающие без строк дольше `idle` забываются.
 */
export class LastResults {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #idle: number;

  /**
   * @param now текущее время, мс
   * @param idle срок забвения вызывающего без строк, мс
   */
  constructor(now: () => number, idle = IDLE_MS) {
    this.#now = now;
    this.#idle = idle;
  }

  /**
   * Память вызывающего `caller`; строка без вызывающего — `NO_CALLER`.
   * Обращение — строка вызывающего: он считается живым.
   */
  of(caller: string | undefined): Memory {
    this.#forget();
    if (caller === undefined) return NO_CALLER;
    const kept = this.#entries.get(caller)?.kept;
    this.#entries.set(caller, { kept, seen: this.#now() });
    return {
      keep: (command, result, argv) =>
        this.#entries.set(caller, {
          kept: { command, result, argv: [...argv] },
          seen: this.#now(),
        }),
      recall: (absent) => this.#recall(caller, absent),
    };
  }

  #recall(caller: string, absent: Receiver): Receiver {
    const kept = this.#entries.get(caller)?.kept;
    return kept === undefined ? absent : new Recalled(kept);
  }

  #forget() {
    const now = this.#now();
    for (const [caller, entry] of this.#entries) {
      if (now - entry.seen > this.#idle) this.#entries.delete(caller);
    }
  }
}

/**
 * Доставка, запоминающая результат: код 0 — команда кладёт его в память
 * (поток она не кладёт); прочее — как у `inner`.
 */
export function remembering(inner: Delivery, memory: Keeper): Delivery {
  return {
    deliver(command, result, args, json, output) {
      const code = inner.deliver(command, result, args, json, output);
      if (code === 0) command.remember(result, args, memory);
      return code;
    },
  };
}

const SAME_DOC: Doc = {
  purpose: "тот же результат",
  help: `Закрытие результат не меняет: слово после ${GRAMMAR.close} — ему же.`,
};

/** Прошлый результат после формата: текст готов, дальше — только `end`. */
class Printed implements Receiver {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  lookup(sent: Sent): Call {
    return sent.route({
      named: () => formatLast(sent),
      tail: () => formatLast(sent),
      close: () => new AsideCall(GRAMMAR.close, SAME_DOC, KIND, () => this),
    });
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.value(this.#text));
  }
}

/** Слово после формата: формат — последним. */
function formatLast(sent: Sent): never {
  throw new Refusal(`не понимает ${sent.selector()}; формат — последним`);
}

/**
 * Прошлый результат: без слова — прежний текст команды; форматы команды
 * и `json` — тем же рендером; отбор — по её данным. Команда не
 * исполняется.
 */
class Recalled implements Receiver {
  readonly #kept: Kept;

  constructor(kept: Kept) {
    this.#kept = kept;
  }

  lookup(sent: Sent): Call {
    return sent.route({
      named: (named) =>
        this.#format(named) ??
          selectionOf(named, KIND, () => this.#source(), () => {
            throw this.#refusal(named.selector());
          }),
      tail: () => {
        throw this.#refusal(sent.selector());
      },
      close: () => new AsideCall(GRAMMAR.close, SAME_DOC, KIND, () => this),
    });
  }

  final(report: Report): Promise<Outcome> {
    const { command, result, argv } = this.#kept;
    return Promise.resolve(report.value(command.renderResult(result, argv)));
  }

  /** Формат команды (`md`) или `json`: рендер без исполнения. */
  #format(named: Named): Call | undefined {
    const text = this.#formatted(named.selector());
    if (text === undefined) return undefined;
    const doc = {
      purpose: `результат в формате ${named.selector()}`,
      help: `Прошлый результат в формате ${named.selector()}.`,
    };
    return new AsideCall(named.text(), doc, KIND, () => new Printed(text()));
  }

  #formatted(name: string): (() => string) | undefined {
    const { command, result, argv } = this.#kept;
    if (name === JSON_FORMAT) return () => jsonOf(command, result, argv);
    const words = command.formats[name];
    if (words === undefined) return undefined;
    return () => command.renderResult(result, flagged(argv, words));
  }

  #source(): Source {
    const { command, result, argv } = this.#kept;
    return {
      select: (_report, replay) => replay(command.dataOf(result, argv)),
    };
  }

  #refusal(selector: string): Refusal {
    const known = [
      JSON_FORMAT,
      ...Object.keys(this.#kept.command.formats).sort(),
      ...selectionMessages().map((line) => line.selector).sort(),
    ];
    return new Refusal(`не понимает ${selector}; есть: ${known.join(", ")}`);
  }
}

/** Формат, который понимает любой результат. */
const JSON_FORMAT = "json";

/** Вид прошлого результата: разбор и отражение — как у данных с отбором. */
const KIND: Yields<Receiver> = {
  ...SELECTABLE.kind,
  receive: (receiver) => receiver,
};

/** Прошлого результата нет: итог — отказ кодом 1, слова за `it` — ему же. */
class Absent implements Receiver {
  readonly #stderr: (text: string) => void;

  constructor(stderr: (text: string) => void) {
    this.#stderr = stderr;
  }

  lookup(sent: Sent): Call {
    return new AsideCall(sent.selector(), SAME_DOC, KIND, () => this);
  }

  final(report: Report): Promise<Outcome> {
    this.#stderr(
      `${report.text()}: нет прошлого результата у этого вызывающего\n`,
    );
    return Promise.resolve(report.exit(1));
  }
}

const IT_DOC: Doc = {
  purpose: "последний результат этого вызывающего",
  help: "Звать, чтобы перерисовать или отобрать прошлый результат без\n" +
    "повторного запроса: mpu it md, mpu it json, mpu it where: … end size.\n" +
    "Ничего не исполняет и правил не спрашивает; помнится результат с\n" +
    "кодом 0, не поток, до перезапуска back или часа без строк.",
};

/**
 * `it` корня: прошлый результат вызывающего строки.
 *
 * @param memory память вызывающего строки
 * @param stderr куда сказать, что прошлого результата нет
 */
export function itMethod(
  memory: Memory,
  stderr: (text: string) => void,
): Method<Line> {
  return unary("it", IT_DOC, KIND, () => memory.recall(new Absent(stderr)));
}
