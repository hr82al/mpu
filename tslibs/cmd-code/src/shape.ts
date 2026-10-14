/**
 * Учёт формы функций одного файла (`specs/code-shape.md`, «Что
 * меряется»): какие функции длиннее предела, какие глубже и где флаг
 * поведения передан литералом.
 *
 * Три раздела выводятся здесь и только здесь: запись функции сама
 * знает свою длину и глубину и сама решает, превышен ли предел и задета
 * ли она изменением. Печать ничего не пересчитывает.
 */

import type { LineFilter } from "./changed_lines.ts";

/** Предел длины функции в строках; ровно столько — не нарушение. */
export const MAX_LENGTH = 40;

/** Предел вложенности операторов управления; ровно столько — не нарушение. */
export const MAX_DEPTH = 3;

/** Длинная функция: первая строка, имя, строк в теле. */
export interface Long {
  readonly line: number;
  readonly name: string;
  readonly length: number;
}

/** Глубокая функция: первая строка, имя, глубина вложенности. */
export interface Deep {
  readonly line: number;
  readonly name: string;
  readonly depth: number;
}

/** Флаг: строка вызова, вызываемое, номер аргумента с единицы. */
export interface Flag {
  readonly line: number;
  readonly call: string;
  readonly argument: number;
}

/** Отрезок строк файла, включительно. */
export class Span {
  constructor(
    readonly first: number,
    readonly last: number,
  ) {}

  /** Сколько строк в отрезке. */
  size(): number {
    return this.last - this.first + 1;
  }

  /** Задет ли отрезок изменением: хоть одна его строка в фильтре. */
  touchedBy(lines: LineFilter): boolean {
    return lines.touches(
      Array.from({ length: this.size() }, (_, i) => this.first + i),
    );
  }
}

/** Кто узнаёт о глубине операторов управления внутри себя. */
export interface Owner {
  /** Внутри встретился оператор управления на уровне `depth`. */
  reach(depth: number): void;
}

/**
 * Владелец вне функции: верхний уровень файла и тело `describe`.
 * Глубину там не меряют — она ничья.
 */
export const NO_OWNER: Owner = { reach: () => {} };

/** Функция файла: её строки, тело и наибольшая глубина внутри. */
export class Measured implements Owner {
  #depth = 0;

  /**
   * `whole` — строки узла функции целиком (их спрашивают у фильтра
   * `--base`), `body` — отрезок, по которому меряется длина.
   */
  constructor(
    private readonly name: string,
    private readonly whole: Span,
    private readonly body: Span,
  ) {}

  reach(depth: number): void {
    this.#depth = Math.max(this.#depth, depth);
  }

  /** Запись «длинные»: тело длиннее предела и функция задета фильтром. */
  long(lines: LineFilter): readonly Long[] {
    const length = this.body.size();
    if (length <= MAX_LENGTH || !this.whole.touchedBy(lines)) return [];
    return [{ line: this.whole.first, name: this.name, length }];
  }

  /** Запись «глубокие»: глубина больше предела и функция задета фильтром. */
  deep(lines: LineFilter): readonly Deep[] {
    if (this.#depth <= MAX_DEPTH || !this.whole.touchedBy(lines)) return [];
    return [{ line: this.whole.first, name: this.name, depth: this.#depth }];
  }
}

/** Булев литерал позиционным аргументом вызова. */
export class FlagCall {
  constructor(
    private readonly call: string,
    private readonly argument: number,
    private readonly span: Span,
  ) {}

  /** Запись «флаги», если вызов задет фильтром. */
  flag(lines: LineFilter): readonly Flag[] {
    if (!this.span.touchedBy(lines)) return [];
    return [
      { line: this.span.first, call: this.call, argument: this.argument },
    ];
  }
}

/**
 * Учёт файла. Записи приходят в порядке обхода дерева, то есть по
 * началу узла: это порядок «по строке» спеки, а при равной строке
 * внешняя запись идёт раньше вложенной.
 */
export class Shape {
  readonly #functions: Measured[] = [];
  readonly #flags: FlagCall[] = [];

  add(fn: Measured): void {
    this.#functions.push(fn);
  }

  addFlag(flag: FlagCall): void {
    this.#flags.push(flag);
  }

  long(lines: LineFilter): Long[] {
    return this.#functions.flatMap((fn) => fn.long(lines));
  }

  deep(lines: LineFilter): Deep[] {
    return this.#functions.flatMap((fn) => fn.deep(lines));
  }

  flags(lines: LineFilter): Flag[] {
    return this.#flags.flatMap((flag) => flag.flag(lines));
  }
}
