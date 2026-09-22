/**
 * Лист ключевой команды (`platform/line-grammar.md`, «Команда-образец»):
 * команда исполняется своим ключевым сообщением. Ключи выводятся из
 * объявления команды — один источник для разбора, справки и строки,
 * которую получает нынешняя диспетчеризация.
 */

import type { Command, InputSpec } from "../command/mod.ts";
import { GRAMMAR, type KeyKind } from "../messages/mod.ts";
import {
  type Args,
  type Call,
  callLine,
  type Closing,
  type Doc,
  type Fallback,
  type Help,
  type Named,
  NO_REMEDY,
  Refusal,
  type Remedy,
  type Sent,
  Shape,
  type Strays,
  type Trace,
} from "../objects/mod.ts";
import type { Line } from "./dispatch.ts";
import type { Order } from "./order.ts";
import { Pending as PendingOf, type ResultOf, type Settle } from "./result.ts";

/** Звено хвоста и пути правил ключевой команды — прежнее. */
const ARGS = "<args>";

/**
 * Конец опций у прежнего разборщика argv: за ним слова — позиционные,
 * даже похожие на флаг. Это его слово, не знак литерала грамматики.
 */
const END_OF_OPTIONS = "--";

/** Строка прежней диспетчеризации, пока она собирается из ключей. */
interface Argv {
  readonly options: string[];
  readonly positional: string[];
}

/** Как значение ключа ложится во вход прежней диспетчеризации. */
interface Placement {
  place(value: string | boolean, into: Argv): void;
}

/** Позиционный вход: значение — словом по порядку входов. */
const POSITIONAL: Placement = {
  place: (value, into) => void into.positional.push(String(value)),
};

/** Вход-флаг: ключ-флаг, выставленный в `true`, — слово флага. */
class FlagPlacement implements Placement {
  readonly #flag: string;

  constructor(flag: string) {
    this.#flag = flag;
  }

  place(value: string | boolean, into: Argv) {
    if (value === true) into.options.push(this.#flag);
  }
}

/** Ключ команды: имя в строке, вид, обязательность и место во входах. */
interface KeySpec {
  readonly name: string;
  readonly kind: KeyKind;
  readonly required: boolean;
  readonly purpose: string;
  readonly placement: Placement;
}

/** Отказ: значение набрано без ключа — с готовой строкой. */
function valueAsKey(pairs: readonly string[]): Refusal {
  return new Refusal("значение — ключом", {
    remedy: { spell: (address) => `: ${callLine(address, pairs)}` },
  });
}

/** Отказ: формат набран флагом — с готовой строкой через закрытие. */
export function formatAsFlag(
  format: string,
  pairs: readonly string[],
): Refusal {
  return new Refusal("формат — сообщение результату", {
    remedy: {
      spell: (address) =>
        `: ${callLine(address, [...pairs, GRAMMAR.close, format])}`,
    },
  });
}

/**
 * Остаток склеенного ключевого сообщения, который получает результат.
 * Проверяется до исполнения: результат его не понимает — отказ.
 */
interface Rest {
  check(formats: readonly string[]): void;
}

/** Остатка нет. */
const NO_REST: Rest = { check() {} };

/**
 * Остаток — ключевое сообщение: виды результата команд понимают только
 * форматы, поэтому он отказывает, называя понятую часть и форматы.
 */
class Leftover implements Rest {
  readonly #understood: string;
  readonly #selector: string;

  constructor(understood: string, selector: string) {
    this.#understood = understood;
    this.#selector = selector;
  }

  check(formats: readonly string[]): never {
    throw new Refusal(
      `понимаю ${this.#understood}; ${this.#selector} результат не ` +
        `понимает; есть: ${formats.join(", ")}`,
    );
  }
}

/** Ключевое сообщение, принятое командой: её ключи и остаток. */
interface Accepted {
  readonly args: Args;
  /** Текст понятой части — звено адреса. */
  readonly text: string;
  readonly rest: Rest;
}

/** Ключи команды, выведенные из её объявления. */
class Keys {
  readonly #path: readonly string[];
  readonly #specs: readonly KeySpec[];
  /** Ключи, которые ложатся позиционно, — по порядку входов. */
  readonly #ordered: readonly string[];
  readonly #formats: ReadonlySet<string>;
  readonly #retired: Readonly<Record<string, string>>;

  constructor(command: Command, formats: readonly string[]) {
    this.#path = command.path;
    this.#formats = new Set(formats);
    this.#retired = command.retired;
    const named = new Map(
      Object.entries(command.keys ?? {}).map(([key, input]) => [input, key]),
    );
    const specs = command.inputs.flatMap((input) =>
      this.#specOf(command, input, named.get(input.name))
    );
    this.#specs = specs;
    this.#ordered = specs
      .filter((spec) => spec.placement === POSITIONAL)
      .map((spec) => spec.name);
  }

  #specOf(
    command: Command,
    input: InputSpec,
    key: string | undefined,
  ): KeySpec[] {
    if (this.#formats.has(input.name)) return [];
    if (this.#retired[input.name] !== undefined) return [];
    const field = command.argsJsonSchema.properties[input.name];
    const required = command.requiredInputNames.includes(input.name);
    const purpose = field.description ?? "";
    if (input.form.positional !== undefined) {
      const name = key ?? input.name;
      return [{
        name,
        kind: "value",
        required,
        purpose,
        placement: POSITIONAL,
      }];
    }
    if (input.kind !== "boolean") {
      // У образцов значения — позиционные входы; вход-опция без места в
      // строке ключей — дефект объявления, а не пустой ключ.
      throw new TypeError(
        `${command.path.join(" ")}: вход-опция ${input.name} без ключа`,
      );
    }
    // Булев вход, включённый по умолчанию, выключают флагом `no-<имя>`.
    const negated = field.default === true;
    const name = negated ? `no-${input.name}` : key ?? input.name;
    const placement = new FlagPlacement(`--${name}`);
    return [{ name, kind: "flag", required: false, purpose, placement }];
  }

  /** Ключевой метод для разбора и справки. */
  describe() {
    return {
      keys: Object.fromEntries(
        this.#specs.map((spec) => [spec.name, spec.kind]),
      ),
      required: this.#specs.filter((spec) => spec.required).map((spec) =>
        spec.name
      ),
      purposes: Object.fromEntries(
        this.#specs.map((spec) => [spec.name, spec.purpose]),
      ),
    };
  }

  /** Первый обязательный ключ, которого нет, по алфавиту — как у разбора. */
  missing(args: Args): string | undefined {
    return this.#specs
      .filter((spec) => spec.required && !(spec.name in args))
      .map((spec) => spec.name)
      .sort()[0];
  }

  /**
   * Ключи сообщения проверены до исполнения: формат флагом, снятый вход,
   * чужой ключ — отказ. Чужой ключ за целым сообщением этой команды
   * начинает остаток — его получает результат (`platform/line-grammar.md`,
   * «Разбор»).
   */
  accept(named: Named): Accepted {
    const entries = Object.entries(named.args());
    const pairs = entries
      .filter(([key]) =>
        !this.#formats.has(key) && this.#retired[key] === undefined
      )
      .flatMap(([key, value]) => [`${key}:`, String(value)]);
    for (const [at, [key, value]] of entries.entries()) {
      if (this.#formats.has(key)) throw formatAsFlag(key, pairs);
      const replacement = this.#retired[key];
      if (replacement !== undefined) {
        throw new Refusal(
          `--${key} снят — цель одна: ${replacement}: ${value}`,
        );
      }
      if (!this.#specs.some((spec) => spec.name === key)) {
        return this.#split(named, entries, at);
      }
    }
    // Недостающий обязательный ключ называет раньше разбор: этот набор
    // ключей ему известен целиком.
    return { args: named.args(), text: named.text(), rest: NO_REST };
  }

  /** Понятая часть — команде, с ключа `at` — остаток результату. */
  #split(
    named: Named,
    entries: readonly (readonly [string, string | boolean])[],
    at: number,
  ): Accepted {
    const understood = entries.slice(0, at);
    const args = Object.fromEntries(understood);
    if (at === 0 || this.missing(args) !== undefined) {
      throw new Refusal(`не понимает ${named.selector()}`);
    }
    const text = understood.map(([key, value]) => `${key}: ${value}`).join(" ");
    const selector = (part: typeof entries) =>
      part.map(([key]) => `${key}:`).join("");
    const rest = new Leftover(
      selector(understood),
      selector(entries.slice(at)),
    );
    return { args, text, rest };
  }

  /** Отказ голым значениям: слова — ключам по порядку входов. */
  bare(words: readonly string[]): Refusal {
    const pairs = words.slice(0, this.#ordered.length).flatMap((word, i) => [
      `${this.#ordered[i]}:`,
      word,
    ]);
    return valueAsKey(pairs);
  }

  /** Строка прежней диспетчеризации: опции, затем `--` и позиционные. */
  order(args: Args): Order {
    const into: Argv = { options: [], positional: [] };
    for (const spec of this.#specs) {
      const value = args[spec.name];
      if (value !== undefined) spec.placement.place(value, into);
    }
    const argv = [
      ...this.#path,
      ...into.options,
      END_OF_OPTIONS,
      ...into.positional,
    ];
    return { argv: () => argv };
  }

  /** Короткая форма флага (`-v`) → ключ с длинным именем (`verbose`). */
  longOf(short: string, command: Command): string | undefined {
    const input = command.inputs.find((one) =>
      one.form.short !== undefined && `-${one.form.short}` === short
    );
    return input === undefined ? undefined : input.name;
  }
}

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

/** Слово за значением ключа у ключевой команды: короткий флаг — полным. */
class KeyStrays implements Strays {
  readonly #command: Command;
  readonly #keys: Keys;

  constructor(command: Command, keys: Keys) {
    this.#command = command;
    this.#keys = keys;
  }

  remedy(word: string): Remedy {
    const long = this.#keys.longOf(word, this.#command);
    if (long === undefined) return NO_REMEDY;
    return {
      spell: (address, taken) =>
        `; флаг — полным именем: ${callLine(address, [...taken, `--${long}`])}`,
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
      into.flags(parts.results.names());
      into.valueTail(ARGS);
    },
  };
  const missing = (): never => {
    throw new Refusal(`не хватает ключа ${keys.missing({})}`);
  };
  const closing: Closing<Line> = {
    close: missing,
    formats: () => parts.results.names(),
  };
  return new Shape<Line>([], {
    fallback,
    ending: { finish: missing },
    closing,
    strays: new KeyStrays(parts.command, keys),
  });
}
