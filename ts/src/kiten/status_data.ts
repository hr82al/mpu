/**
 * Сбор строк `mpu kiten status` (`docs/specs/kiten-status.md`) из трёх
 * источников: назначенное, списанное время и лента действий. Здесь —
 * только правила над уже полученными данными: слияние, попадание в
 * выдачу, сортировка и фильтры. Запросы — дело команды.
 *
 * Ни один источник по отдельности не полон, и версии одной карточки
 * приходят разной полноты: из time-logs и ленты — усечёнными. Поэтому
 * слияние выбирает не «первую» и не «последнюю» версию, а ту, у
 * которой известно название колонки: этап строки считается по нему.
 */

import { isEscalated, type Stage, stageOf } from "./stage.ts";

/** Почему карточка в выдаче. */
export type StatusSource = "assigned" | "time" | "activity";

/** Версия карточки от одного источника — как она пришла. */
export interface StatusInput {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  /** Название колонки; у усечённых версий его нет. */
  readonly column: string | null;
  readonly board: string | null;
  readonly space: string | null;
  readonly lane: string | null;
  /** Метка состояния карточки (`kiten-card.md`). */
  readonly state: string | null;
  /** `condition` карточки: 1 — активная, 2 — архивная. */
  readonly condition: number | null;
  readonly archived: boolean;
  readonly dueDate: string | null;
  /** Момент последнего изменения, ISO-8601; неизвестен — `null`. */
  readonly updated: string | null;
  readonly source: StatusSource;
}

/** Строка выдачи: одна на карточку. */
export interface StatusRow {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly stage: Stage;
  readonly column: string | null;
  readonly board: string | null;
  readonly space: string | null;
  readonly lane: string | null;
  readonly state: string | null;
  readonly closed: boolean;
  readonly escalated: boolean;
  readonly dueDate: string | null;
  readonly updated: string | null;
  readonly myMinutes: number;
  /** Источники по алфавиту; пустым не бывает (инвариант спеки). */
  readonly sources: readonly StatusSource[];
  /**
   * Живая ли карточка: `condition=1` и не в архиве. В вывод не идёт —
   * рендер перечисляет свои пятнадцать ключей сам, — но нужна отбору:
   * завершённая по этапу карточка (`state=done`) при этом остаётся
   * живой, и окно `--since` к ней не применяется (спека, п. 6).
   */
  readonly alive: boolean;
}

/** Чем сужают выдачу; не заданное поле ступень не создаёт. */
export interface StatusFilters {
  readonly stage?: Stage;
  readonly board?: string;
  readonly source?: StatusSource | "touch";
  readonly only?: "open" | "done";
}

/**
 * Слияние версий по id карточки. Побеждает версия с известным
 * названием колонки — усечённые версии из time-logs и ленты теряют
 * место карточки, и взятая от них строка показала бы этап `—` при
 * известном на самом деле этапе.
 */
export function mergeInputs(
  inputs: readonly StatusInput[],
  minutes: Readonly<Record<number, number>>,
  stageMap: Readonly<Record<string, Stage>> = {},
): readonly StatusRow[] {
  const best = new Map<number, StatusInput>();
  const sources = new Map<number, Set<StatusSource>>();
  for (const input of inputs) {
    const known = sources.get(input.id) ?? new Set<StatusSource>();
    known.add(input.source);
    sources.set(input.id, known);
    const current = best.get(input.id);
    if (
      current === undefined ||
      (current.column === null && input.column !== null)
    ) {
      best.set(input.id, input);
    }
  }
  return [...best.values()].map((card) => ({
    id: card.id,
    title: card.title,
    url: card.url,
    stage: stageOf(card.column, stageMap),
    column: card.column,
    board: card.board,
    space: card.space,
    lane: card.lane,
    state: card.state,
    closed: isClosed(card),
    escalated: isEscalated(card.column),
    dueDate: card.dueDate,
    updated: card.updated,
    myMinutes: minutes[card.id] ?? 0,
    sources: [...(sources.get(card.id) ?? [])].sort(),
    alive: card.condition !== 2 && !card.archived,
  }));
}

/**
 * Попадание в выдачу: живая карточка либо изменённая внутри окна
 * `--since`. Архивные видны только внутри окна — иначе выдача заросла
 * бы всем, что когда-то трогали.
 */
export function inWindow(row: StatusRow, sinceSeconds: number): boolean {
  if (row.alive) return true;
  const updated = row.updated === null ? NaN : Date.parse(row.updated);
  if (!Number.isFinite(updated)) return false;
  return dayOf(updated / 1000) >= dayOf(sinceSeconds);
}

/** Сортировка: незавершённые выше, внутри — по `updated` по убыванию. */
export function sortRows(rows: readonly StatusRow[]): readonly StatusRow[] {
  return [...rows].sort((left, right) => {
    if (left.closed !== right.closed) return left.closed ? 1 : -1;
    return momentOf(right.updated) - momentOf(left.updated);
  });
}

/** Фильтры выдачи; каждый независим и состава полей строки не меняет. */
export function applyFilters(
  rows: readonly StatusRow[],
  filters: StatusFilters,
): readonly StatusRow[] {
  return rows.filter((row) => {
    if (filters.stage !== undefined && row.stage !== filters.stage) {
      return false;
    }
    if (filters.board !== undefined && row.board !== filters.board) {
      return false;
    }
    if (filters.only === "open" && row.closed) return false;
    if (filters.only === "done" && !row.closed) return false;
    if (filters.source === undefined) return true;
    if (filters.source === "touch") {
      // `touch` — карточка ТОЛЬКО из ленты: не назначена и времени по
      // ней я не списывал (спека, «CLI-контракт»).
      return row.sources.length === 1 && row.sources[0] === "activity";
    }
    return row.sources.includes(filters.source);
  });
}

/** Завершённая строка: этап `done` либо архив (спека). */
function isClosed(card: StatusInput): boolean {
  return card.state === "done" || card.condition === 2 || card.archived;
}

/** Начало суток момента в unix-секундах: окна считаются по дням. */
function dayOf(seconds: number): number {
  return Math.floor(seconds / 86_400);
}

function momentOf(updated: string | null): number {
  const parsed = updated === null ? NaN : Date.parse(updated);
  return Number.isFinite(parsed) ? parsed : 0;
}
