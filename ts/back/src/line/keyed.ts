/**
 * Лист ключевой команды (`platform/line-grammar.md`, «Команда-образец»):
 * команда исполняется своим ключевым сообщением. Ключи выводятся из
 * объявления команды — один источник для разбора, справки и строки,
 * которую получает нынешняя диспетчеризация.
 */

import type { Command } from "../command/mod.ts";
import {
  type Call,
  callLine,
  type Doc,
  type Fallback,
  type Help,
  NO_REMEDY,
  type Remedy,
  type Sent,
  Shape,
  type Strays,
  type Trace,
} from "../objects/mod.ts";
import type { Line } from "./dispatch.ts";
import { formatAsFlag, Keys, NO_REST, type Rest } from "./keys.ts";
import type { Order } from "./order.ts";
import { Pending as PendingOf, type ResultOf, type Settle } from "./result.ts";

/** Звено хвоста и пути правил ключевой команды — прежнее. */
const ARGS = "<args>";

/**
 * Формат, снятый со строки до обхода (`--json` где угодно): у ключевой
 * команды это отказ, у хвостовой — прежний общий путь JSON.
 */
export interface Stripped {
  /** Отказывает, если формат набран флагом. */
  check(): void;
}

/** Флага формата в строке не было. */
export const NOTHING_STRIPPED: Stripped = { check() {} };

/** В строке был `--json`: формат — сообщением после закрытия. */
export const JSON_STRIPPED: Stripped = {
  check() {
    throw formatAsFlag("json", []);
  },
};

/** Ключи набраны: строка к исполнению, ещё не исполненная. */
class Keyed {
  readonly #line: Line;
  readonly #order: Order;
  readonly #stripped: Stripped;
  readonly #rest: Rest;
  readonly #formats: readonly string[];

  constructor(
    line: Line,
    order: Order,
    stripped: Stripped,
    rest: Rest,
    formats: readonly string[],
  ) {
    this.#line = line;
    this.#order = order;
    this.#stripped = stripped;
    this.#rest = rest;
    this.#formats = formats;
  }

  /** Строка к исполнению — после проверок, до исполнения. */
  pending(): PendingOf {
    this.#stripped.check();
    this.#rest.check(this.#formats);
    return new PendingOf(this.#line, this.#order);
  }
}

/** Ключевой вызов: звено пути правил — прежнее `<args>`. */
class KeyCall implements Call {
  readonly #text: string;
  readonly #doc: Doc;
  readonly #shape: Shape<Keyed>;
  readonly #keyed: Keyed;

  constructor(text: string, doc: Doc, shape: Shape<Keyed>, keyed: Keyed) {
    this.#text = text;
    this.#doc = doc;
    this.#shape = shape;
    this.#keyed = keyed;
  }

  trace(trail: Trace) {
    trail.step(ARGS, this.#text);
  }

  result(): Shape<Keyed> {
    return this.#shape;
  }

  help(trail: Trace): Help {
    return this.#shape.about(trail.textWith(this.#text), this.#doc);
  }

  perform() {
    return Promise.resolve(this.#shape.receive(this.#keyed));
  }
}

/**
 * Слово за значением ключа у ключевой команды: короткий флаг — полным
 * именем или ключом, если вход переименован (`-m x` → `text: x`).
 */
class KeyStrays implements Strays {
  readonly #keys: Keys;

  constructor(keys: Keys) {
    this.#keys = keys;
  }

  remedy(word: string, after: readonly string[]): Remedy {
    const hint = this.#keys.short(word, after);
    if (hint === undefined) return NO_REMEDY;
    return {
      spell: (address, taken) =>
        `; ${hint.reason}: ${callLine(address, [...taken, ...hint.words])}`,
    };
  }
}

/** Что нужно листу ключевой команды от дерева. */
export interface KeyedParts {
  readonly command: Command;
  readonly doc: Doc;
  readonly results: ResultOf;
  readonly settle: Settle;
  readonly stripped: Stripped;
}

/**
 * Лист ключевой команды: ключевое сообщение — строка к исполнению; голые
 * значения, формат флагом, снятый вход и недостающий ключ — отказы.
 */
export function keyedLeaf(parts: KeyedParts): Shape<Line> {
  const keys = new Keys(parts.command, parts.results.names());
  const keyed = new Shape<Keyed>([], {
    ending: {
      finish: (report, self) => self.pending().settle(report, parts.settle),
    },
    closing: parts.results.closing((self: Keyed) => self.pending()),
  });
  const fallback: Fallback<Line> = {
    understand(sent: Sent, line: Line, refuse: () => Call): Call {
      return sent.route({
        named(named) {
          const accepted = keys.accept(named);
          const state = new Keyed(
            line,
            keys.order(accepted.args),
            parts.stripped,
            accepted.rest,
            parts.results.names(),
          );
          return new KeyCall(accepted.text, parts.doc, keyed, state);
        },
        tail: () =>
          sent.viaLink({
            word: (word) => {
              throw keys.bare([word]);
            },
            words: (words) => {
              throw keys.bare(words);
            },
            refuse,
          }),
        close: refuse,
      });
    },
    lines: () => [],
    describe(into) {
      into.keyword(keys.describe());
      into.flags(keys.flagWords(parts.results.names()));
      into.valueTail(ARGS);
    },
  };
  // Ключевого сообщения нет: строка без ключей, если требовать нечего.
  const bare = (line: Line) =>
    new Keyed(
      line,
      keys.order(keys.none()),
      parts.stripped,
      NO_REST,
      parts.results.names(),
    );
  return new Shape<Line>([], {
    fallback,
    ending: {
      finish: (report, line) =>
        bare(line).pending().settle(report, parts.settle),
    },
    closing: parts.results.closing((line: Line) => bare(line).pending()),
    strays: new KeyStrays(keys),
  });
}

/**
 * Адреса входов команды в новой записи. Команда без ключей пока принимает
 * прежнюю строку хвостом — все её входы адресуются хвостом.
 */
export function addressesOf(
  command: Command,
  formats: readonly string[],
): ReadonlyMap<string, string> {
  if (command.keys === undefined) {
    return new Map(command.inputs.map((input) => [input.name, "хвост"]));
  }
  return new Keys(command, formats).addresses();
}
