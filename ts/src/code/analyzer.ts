/**
 * Общий слой семейства `mpu code` (`platform/code-analyzer.md`): что
 * анализатор умеет и в каких понятиях отвечает.
 *
 * Смысл слоя один: ответ полон либо назван неполным. Поэтому ссылка,
 * которую разобрать не удалось, — не выброшенная строка, а элемент
 * ответа со своей причиной, а гарантия печатается всегда, в том числе
 * полная.
 */

import type { Bodies } from "./body.ts";
import type { Guarantee, MarkSource } from "./mark.ts";

/**
 * Область видимости объявления — одно значение, а не два независимых
 * признака (`platform/code-analyzer.md`, «Область видимости»).
 *
 * `no-entry` отличается от `module-only` тем, что вход проекта не
 * «не реэкспортирует», а отсутствует: сказать про реэкспорт там нечего.
 * `entry-unknown` — манифест пакета не разобрался, и вход не определён;
 * молчаливое «входа нет» тут запрещено: это разные ответы.
 * Значения «неизвестно» здесь нет: объявления печатает только разбор по
 * типам, а текстовый отвечает на эту операцию отказом.
 */
export type Scope =
  | "entry"
  | "module-only"
  | "no-entry"
  | "entry-unknown"
  | "private";

/** Объявление в файле репозитория. */
export interface Declaration {
  readonly name: string;
  /** Сигнатура для человека: `(day: string, count: number): string`. */
  readonly signature: string;
  /**
   * Тип возврата вызываемого объявления; `null` — объявление не
   * вызывается. Отдельным полем, а не разбором строки сигнатуры:
   * вытаскивать его обратно из текста значило бы читать собственный
   * вывод как данные.
   */
  readonly returnType: string | null;
  /**
   * Типы параметров вызываемого объявления по порядку; `null` —
   * объявление не вызывается. По ним ищутся соседи по сигнатуре: имя
   * может быть свободно, а вещь под другим именем уже существовать.
   */
  readonly paramTypes: readonly string[] | null;
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

/**
 * Ответ операции «объявления файла». Незнание — ответ операции, а не её
 * отсутствие: текстовый анализатор объявлений не разбирает и говорит об
 * этом, а команда превращает это в отказ (`platform/code-analyzer.md`).
 */
export type Declarations =
  | { readonly kind: "known"; readonly declarations: readonly Declaration[] }
  | { readonly kind: "unknown"; readonly reason: string };

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
  /** Файлы репозитория, которые анализатор разбирает; пути от корня. */
  readonly files: () => readonly string[];
  /** Объявления файла по возрастанию строки. */
  readonly declarationsOf: (path: string) => Declarations;
  /**
   * Почему объявления здесь не разбираются; `null` — разбираются.
   * Отдельным членом, а не зондом `declarationsOf` по заведомо неверному
   * пути: контракт той операции — объявления ФАЙЛА, и спрашивать её о
   * репозитории значит полагаться на побочный ответ.
   */
  readonly declarationsRefusal: () => string | null;
  /** Тела объявлений-функций репозитория. */
  readonly bodiesOf: () => Bodies;
  /** Файлы-потребители цели; единица — файл, а не обращение. */
  readonly consumersOf: (target: Target) => readonly Place[];
  /**
   * Ссылки репозитория, которые разрешить не удалось. Отдельно от
   * потребителей: раздел «не разрешено» печатается в ответе любой
   * поверхности, в том числе той, что о потребителях не спрашивает
   * (`platform/code-analyzer.md`, «Форма ответа»).
   */
  readonly unresolvedOf: () => readonly Unresolved[];
}

/** Порядок строк слоя: `(репозиторий, путь, строка)`. */
export function byPathAndLine(a: Place, b: Place): number {
  return a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;
}
