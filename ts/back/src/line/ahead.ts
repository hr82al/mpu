/**
 * Обход программы до исполнения (`platform/ask-composite.md`): команды,
 * до которых вычисление может дойти, решаются правилами раньше первой из
 * них. Запрет — отказ правила; запись без двери — отказ всей строки с
 * подсказкой начать её с `ask`; прочее — исполнение, вопрос — при отправке.
 */

import { UNNAMED_REFUSAL } from "@mpu/language/messages";
import {
  line as lineText,
  type Outcome,
  plainRefusal,
  RefusalNotice,
  type Refused,
  type Report,
  ROOT_TEXT,
  throughGate,
} from "@mpu/language/objects";
import {
  type Address,
  EXECUTE,
  type Execution,
  NOBODY,
  PolicyError,
  REDIRECT,
  type Ruling,
} from "@mpu/command/policy";
import type { Reach } from "@mpu/language/program";
import type { Speech } from "./printed.ts";
import { ARGS } from "./tree.ts";
import { ASK_WORD, DOOR, NORMAL, type View } from "./view.ts";

/** Вид отказа: строка без двери может дойти до записи. */
const MAY_WRITE = "строка может записать";

/** Код отказа до исполнения — ошибка адреса. */
const MISADDRESSED = 2;

/** Код отказа правила. */
const RULED_OUT = 1;

/**
 * Отказ всей строки: её команда `path` может записать, а строка начата
 * без двери. Один на обход и на отправку.
 *
 * @param name как строку называет отказ (`mpu kiten comment …`, `stdin`)
 * @param typed набранные слова строки — подсказка ставит дверь перед ними
 */
export function needsDoor(
  name: string,
  typed: readonly string[],
  path: readonly string[],
): Refused {
  const hint = throughGate(` — начни с ${ASK_WORD}: `, ASK_WORD).hint({
    address: "",
    taken: [],
    line: typed,
    start: 0,
    end: typed.length,
  });
  return new RefusalNotice({
    reason: MAY_WRITE,
    said: `${name}: ${MAY_WRITE} (${path.join(" ")})`,
    hint,
    candidates: [],
  });
}

/** Строка, которая сама называет себя в отказе «может записать». */
export interface Doorless {
  /** Отказ всей строки: команда `path` может записать. */
  needsDoor(path: readonly string[]): Refused;
}

/**
 * Подстрока программы без двери, решённая `ask` при отправке (правило
 * сменили посреди строки), — тот же отказ всей строки, код 2.
 *
 * @param line строка программы
 * @param told куда сказать отказ
 */
export function redirected(
  line: Doorless,
  told: Speech,
): (report: Report) => Promise<Outcome> {
  return (report) => {
    const path = report.links().filter((link) => link !== ARGS);
    line.needsDoor(path).tell(told);
    return Promise.resolve(report.exit(MISADDRESSED));
  };
}

/** Итог обхода: исполнять строку или чем отказать. */
export interface Finding {
  /** Итог вместе со следующей находкой. */
  and(next: Finding): Finding;
  /** Итог, если раньше найдена команда без двери `door`. */
  beside(door: NeedsDoor): Finding;
  /** Отказ — сказать и отдать код; иначе исполнить `run`. */
  settle(told: Speech, run: () => Promise<number>): Promise<number>;
}

/** Ничего не мешает: строка исполняется. */
const CLEAR: Finding = {
  and: (next) => next,
  beside: (door) => door,
  settle: (_told, run) => run(),
};

/** Команда, решённая `ask`, в строке без двери: первая такая. */
class NeedsDoor implements Finding {
  readonly #line: Doorless;
  readonly #path: readonly string[];

  constructor(line: Doorless, path: readonly string[]) {
    this.#line = line;
    this.#path = path;
  }

  and(next: Finding): Finding {
    return next.beside(this);
  }

  /** Раньше найденная команда без двери — её и называет отказ. */
  beside(door: NeedsDoor): Finding {
    return door;
  }

  settle(told: Speech): Promise<number> {
    this.#line.needsDoor(this.#path).tell(told);
    return Promise.resolve(MISADDRESSED);
  }
}

/** Отказ правила (запрет, нечитаемый файл): старше всякой другой находки. */
class RuledOut implements Finding {
  readonly #refused: Refused;

  constructor(reason: string, text: string) {
    this.#refused = plainRefusal(reason, text);
  }

  and(): Finding {
    return this;
  }

  beside(): Finding {
    return this;
  }

  settle(told: Speech): Promise<number> {
    this.#refused.tell(told);
    return Promise.resolve(RULED_OUT);
  }
}

/**
 * Вход строки: слова, которыми он начинает подстроки, адрес обхода и
 * взгляд, которым решается строка образа (`platform/image.md`).
 */
export interface Entry {
  readonly words: readonly string[];
  readonly ahead: Address;
  readonly view: View;
}

/** Через дверь: `ask` проходит обход, вопрос — при отправке. */
const THROUGH_DOOR: Entry = {
  words: [ASK_WORD],
  ahead: { onAllow: () => EXECUTE, onAsk: () => EXECUTE },
  view: DOOR,
};

/** Без двери: `ask` — отказ всей строки. */
const OUTSIDE: Entry = {
  words: [],
  ahead: { onAllow: () => EXECUTE, onAsk: () => REDIRECT },
  view: NORMAL,
};

/** Вход строки по её первому слову. */
export function entryOf(words: readonly string[]): Entry {
  return words[0] === ASK_WORD ? THROUGH_DOOR : OUTSIDE;
}

/**
 * Собиратель обхода: команды копятся по порядку строки, решаются все
 * сразу, когда обход кончился.
 */
export class Ahead implements Reach {
  readonly #line: Doorless;
  readonly #found: { path: readonly string[]; links: readonly string[] }[] = [];

  /** @param line строка программы — отказ всей строки называет её сама */
  constructor(line: Doorless) {
    this.#line = line;
  }

  command(path: readonly string[], links: readonly string[]) {
    this.#found.push({ path, links });
  }

  /**
   * Итог обхода: каждая команда решается правилами у адреса обхода.
   *
   * @param decide решение правил для звеньев пути
   * @param address адрес обхода: в двери или без неё
   */
  async verdict(
    decide: (links: readonly string[]) => Ruling,
    address: Address,
  ): Promise<Finding> {
    let finding = CLEAR;
    for (const { path, links } of this.#found) {
      finding = finding.and(await this.#one(decide, links, path, address));
    }
    return finding;
  }

  #one(
    decide: (links: readonly string[]) => Ruling,
    links: readonly string[],
    path: readonly string[],
    address: Address,
  ): Promise<Finding> {
    let ruling: Ruling;
    try {
      ruling = decide(links);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      return Promise.resolve(new RuledOut(UNNAMED_REFUSAL, err.message));
    }
    return ruling.settle(this.#probe(path), NOBODY, address);
  }

  /** Строка команды глазами обхода: ничего не исполняет и не спрашивает. */
  #probe(path: readonly string[]): Execution<Finding> {
    return {
      text: lineText(ROOT_TEXT, path),
      run: () => Promise.resolve(CLEAR),
      refuse: (reason, text) => Promise.resolve(new RuledOut(reason, text)),
      redirect: () => Promise.resolve(new NeedsDoor(this.#line, path)),
    };
  }
}
