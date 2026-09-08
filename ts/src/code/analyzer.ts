/**
 * Общий слой семейства `mpu code` (`platform/code-analyzer.md`): что
 * анализатор умеет и в каких понятиях отвечает.
 *
 * Смысл слоя один: ответ полон либо назван неполным. Поэтому ссылка,
 * которую разобрать не удалось, — не выброшенная строка, а элемент
 * ответа со своей причиной, а гарантия печатается всегда, в том числе
 * полная.
 */

import type { Guarantee, MarkSource } from "./mark.ts";

/**
 * Область видимости объявления — одно значение, а не два независимых
 * признака (`platform/code-analyzer.md`, «Область видимости»).
 *
 * `no-entry` отличается от `module-only` тем, что вход проекта не
 * «не реэкспортирует», а отсутствует: сказать про реэкспорт там нечего.
 * `unknown` — область видимости не выяснена вовсе: так отвечает
 * текстовый разбор, у которого типов нет. Пропуск строки читался бы как
 * «символ приватный», а это другой ответ.
 */
export type Scope =
  | "entry"
  | "module-only"
  | "no-entry"
  | "private"
  | "unknown";

/** Объявление в файле репозитория. */
export interface Declaration {
  readonly name: string;
  /**
   * Сигнатура для человека: `(day: string, count: number): string`.
   * `null` — форма объявления не выяснена: так отвечает текстовый
   * разбор, и незнание называется вслух, а не печатается пустотой.
   */
  readonly signature: string | null;
  /** Строка объявления, считая с единицы. */
  readonly line: number;
  readonly scope: Scope;
}

/** Цель вопроса: символ, объявленный в строке, либо модуль целиком. */
export type Target =
  | { readonly kind: "symbol"; readonly path: string; readonly line: number }
  | { readonly kind: "module"; readonly path: string };

/** Место потребителя: файл и строка, которой он цель получает. */
export interface Place {
  readonly path: string;
  readonly line: number;
}

/** Ссылка, которую разрешить не удалось; молча выпасть она не может. */
export interface Unresolved {
  readonly path: string;
  readonly line: number;
  /** Как ссылка записана в исходнике: `./nowhere`. */
  readonly specifier: string;
  readonly reason: string;
}

/** Ответ на вопрос о потребителях цели. */
export interface Consumers {
  /** Единица — файл: один файл встречается один раз. */
  readonly places: readonly Place[];
  readonly unresolved: readonly Unresolved[];
}

/**
 * Анализатор одного репозитория. Реализаций две — по типам и текстовая
 * — с одним набором операций и разной гарантией; выбор между ними
 * делает наличие проекта, покрывающего файл.
 */
export interface Analyzer {
  readonly guarantee: Guarantee;
  readonly mark: MarkSource;
  /** Есть ли такой файл в дереве репозитория. */
  readonly hasFile: (path: string) => boolean;
  /** Объявления файла по возрастанию строки. */
  readonly declarationsOf: (path: string) => readonly Declaration[];
  readonly consumersOf: (target: Target) => Consumers;
}

/** Порядок строк слоя: `(репозиторий, путь, строка)`. */
export function byPathAndLine(a: Place, b: Place): number {
  return a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;
}
