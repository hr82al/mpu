/**
 * Учёт копий одного файла (`specs/code-copies.md`, «Что считается»):
 * какие фрагменты повторены и какая константа файла преобразуется по
 * месту не один раз.
 *
 * Оба раздела выводятся из одного — из групп равных фрагментов: копия —
 * группа выше обоих порогов, которую не поглощает другая; преобразование
 * — группа вызовов с порогом 2. Поэтому счёт, строки и решение «печатать
 * ли» держит группа, а не тот, кто печатает.
 */

import type { LineFilter } from "./changed_lines.ts";

/** Копия — не меньше стольких вхождений… */
export const MIN_COPIES = 3;
/** …и не меньше стольких лексем. */
export const MIN_TOKENS = 20;
/** Преобразование печатается, повторённое не меньше стольких раз. */
export const MIN_CONVERSIONS = 2;

/** Длиннее стольких знаков текст копии усекается. */
export const MAX_TEXT = 60;

/** Копия: текст первого вхождения, число вхождений и их строки. */
export interface Copy {
  readonly text: string;
  readonly count: number;
  readonly lines: number[];
}

/** Преобразование константы: текст вызова, число вхождений и строки. */
export interface Conversion {
  readonly call: string;
  readonly count: number;
  readonly lines: number[];
}

/** Фрагмент файла: лексемы ключом, их число, исходный текст и место. */
export interface Fragment {
  readonly key: string;
  readonly size: number;
  readonly text: string;
  readonly span: Span;
}

/** Место вхождения в файле: отрезок текста и строки, которые он занимает. */
export class Span {
  constructor(
    private readonly start: number,
    private readonly end: number,
    readonly line: number,
    private readonly lastLine: number,
  ) {}

  /** Лежит ли вхождение внутри другого. */
  within(other: Span): boolean {
    return other.start <= this.start && this.end <= other.end;
  }

  /** Порядок по началу: отрицательное — это вхождение раньше. */
  order(other: Span): number {
    return this.start - other.start;
  }

  /** Все строки вхождения, от строки начала до строки конца. */
  lines(): number[] {
    return Array.from(
      { length: this.lastLine - this.line + 1 },
      (_, i) => this.line + i,
    );
  }
}

/** Равные фрагменты файла: сама считает вхождения и решает о печати. */
class Group {
  readonly #spans: Span[] = [];

  /**
   * @param size число лексем фрагмента
   * @param text исходный текст первого вхождения, пробелы сжаты
   */
  constructor(
    readonly size: number,
    readonly text: string,
  ) {}

  add(span: Span): void {
    this.#spans.push(span);
  }

  get count(): number {
    return this.#spans.length;
  }

  /** Копия — оба порога спеки. */
  isCopy(): boolean {
    return this.count >= MIN_COPIES && this.size >= MIN_TOKENS;
  }

  /** Преобразование печатается, повторённое не меньше двух раз. */
  isRepeatedConversion(): boolean {
    return this.count >= MIN_CONVERSIONS;
  }

  /**
   * Поглощена ли группой `other`: у той столько же вхождений, она
   * длиннее, и каждое вхождение этой лежит внутри какого-нибудь её.
   */
  absorbedBy(other: Group): boolean {
    return (
      other.count === this.count &&
      other.size > this.size &&
      this.#spans.every((span) => other.#spans.some((o) => span.within(o)))
    );
  }

  /** Задета ли фильтром: спрашиваются все строки всех вхождений. */
  touches(filter: LineFilter): boolean {
    return filter.touches(this.#spans.flatMap((span) => span.lines()));
  }

  /** Порядок: по началу первого вхождения, при равном — длиннее раньше. */
  order(other: Group): number {
    return this.#spans[0].order(other.#spans[0]) || other.size - this.size;
  }

  /** Строки начала вхождений по возрастанию, каждая один раз. */
  lines(): number[] {
    const lines = new Set(this.#spans.map((span) => span.line));
    return [...lines].sort((a, b) => a - b);
  }
}

/**
 * Учёт одного файла. Принимает фрагменты и преобразования
 * сообщениями-намерениями обхода и отдаёт оба раздела.
 */
export class FileCopies {
  readonly #fragments = new Map<string, Group>();
  readonly #conversions = new Map<string, Group>();

  /** Фрагмент — кандидат в копии. */
  addFragment(fragment: Fragment): void {
    groupOf(this.#fragments, fragment, shorten).add(fragment.span);
  }

  /**
   * Вызов-преобразование константы: текст первого вхождения с сжатыми
   * пробелами, без усечения.
   */
  addConversion(fragment: Fragment): void {
    groupOf(this.#conversions, fragment, squeeze).add(fragment.span);
  }

  /**
   * Копии, задетые фильтром строк. Поглотитель с тем же числом
   * вхождений и большей длиной копией является сам, поэтому кандидаты в
   * поглотители — только копии.
   */
  copies(filter: LineFilter): readonly Copy[] {
    const copies = [...this.#fragments.values()].filter((g) => g.isCopy());
    return copies
      .filter((group) => !copies.some((other) => group.absorbedBy(other)))
      .filter((group) => group.touches(filter))
      .sort((a, b) => a.order(b))
      .map((group) => ({
        text: group.text,
        count: group.count,
        lines: group.lines(),
      }));
  }

  /** Преобразования, повторённые не меньше двух раз и задетые фильтром. */
  conversions(filter: LineFilter): readonly Conversion[] {
    return [...this.#conversions.values()]
      .filter((group) => group.isRepeatedConversion())
      .filter((group) => group.touches(filter))
      .sort((a, b) => a.order(b))
      .map((group) => ({
        call: group.text,
        count: group.count,
        lines: group.lines(),
      }));
  }
}

/** Группа фрагмента; первой встречи — новая, с текстом первого вхождения. */
function groupOf(
  groups: Map<string, Group>,
  fragment: Fragment,
  shown: (text: string) => string,
): Group {
  const known = groups.get(fragment.key);
  if (known !== undefined) return known;
  const group = new Group(fragment.size, shown(fragment.text));
  groups.set(fragment.key, group);
  return group;
}

/**
 * Каждая цепочка пробельных знаков — один пробел: вывод построчный, и
 * перевод строки внутри фрагмента разорвал бы запись на две.
 */
function squeeze(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Текст копии: сжат и не длиннее 60 знаков — первые 59 и `…`. */
function shorten(text: string): string {
  const signs = Array.from(squeeze(text));
  if (signs.length <= MAX_TEXT) return signs.join("");
  return `${signs.slice(0, MAX_TEXT - 1).join("")}…`;
}
