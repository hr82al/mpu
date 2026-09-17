/**
 * Живой опрос Kaiten для дневного отчёта
 * (`docs/specs/telegram-status.md`, «Ввод/вывод», живой опрос):
 * мои сегодняшние смены колонки и их подписи.
 *
 * Kaiten объявлен узким интерфейсом потребителя: выбор записей, обход
 * досок и обе ветви предупреждений проверяются без сети.
 */

import type { DayWindow } from "./status_day.ts";
import type { CardMove } from "./status_report.ts";

/** Карточка выборки: id, заголовок и доска — больше отчёту не нужно. */
export interface StatusCard {
  readonly id: number;
  readonly title: string | null;
  /** Доска карточки; её нет — названия колонок взять неоткуда. */
  readonly boardId: number | null;
}

/** Смена положения карточки из её истории перемещений. */
export interface StatusChange {
  readonly columnId: number | null;
  readonly authorId: number | null;
  /** Момент смены, ISO-8601 UTC; его нет — запись в отчёт не годится. */
  readonly changed: string | null;
}

/** Колонка доски: подпись места в отчёте. */
export interface StatusColumn {
  readonly id: number;
  readonly title: string;
}

/** Что нужно живому опросу от Kaiten. */
export interface LiveSource {
  /** Владелец токена: «мои» перемещения считаются по нему. */
  readonly currentUserId: () => Promise<number>;
  /** Карточки, тронутые мной за окно дня. */
  readonly cardsUpdated: (
    memberId: number,
    window: DayWindow,
  ) => Promise<readonly StatusCard[]>;
  readonly cardHistory: (cardId: number) => Promise<readonly StatusChange[]>;
  readonly boardColumns: (boardId: number) => Promise<readonly StatusColumn[]>;
}

/** Окружение сбора: окно дня, web-URL карточки и приёмник предупреждений. */
export interface LiveOptions {
  readonly window: DayWindow;
  readonly cardUrl: (cardId: number) => string;
  /** Строка предупреждения; печатает её вызывающий, в stderr. */
  readonly warn: (line: string) => void;
}

/** Колонка без идентификатора: подписать её нечем. */
const NO_COLUMN = "—";

/** Предупреждение о пропущенном живом опросе — отчёт строится на журнале. */
export function liveSkippedWarning(cause: unknown): string {
  return `mpu telegram status: live-обогащение пропущено (Kaiten: ${
    reason(cause)
  })`;
}

/**
 * Предупреждение о недоступной истории одной карточки: без него
 * карточка исчезала бы из отчёта без следа (там же, «Известные
 * отклонения», вердикт fix).
 */
function historyWarning(cardId: number, cause: unknown): string {
  return `mpu telegram status: история карточки ${cardId} недоступна (Kaiten: ${
    reason(cause)
  })`;
}

/**
 * Мои сегодняшние перемещения по данным Kaiten. Отказ на карточке
 * пропускает карточку, отказ на доске — только её подписи; отказ до
 * выборки поднимается вызывающему, и тот строит отчёт на журнале.
 */
export async function liveMoves(
  source: LiveSource,
  options: LiveOptions,
): Promise<readonly CardMove[]> {
  const me = await source.currentUserId();
  const cards = await source.cardsUpdated(me, options.window);
  const columns = new BoardColumns(source);
  const moves: CardMove[] = [];
  for (const card of cards) {
    const change = await lastChange(source, card, me, options);
    if (change === null) continue;
    moves.push({
      cardId: card.id,
      title: card.title,
      url: options.cardUrl(card.id),
      column: await columns.title(card.boardId, change.columnId),
      movedAt: change.atSec,
    });
  }
  return moves;
}

/** Смена колонки с уже разобранным моментом: он нужен и отбору, и отчёту. */
interface DatedChange {
  readonly columnId: number | null;
  readonly atSec: number;
}

/** Моя последняя смена колонки за окно; её нет — карточка не в отчёте. */
async function lastChange(
  source: LiveSource,
  card: StatusCard,
  me: number,
  options: LiveOptions,
): Promise<DatedChange | null> {
  let history: readonly StatusChange[];
  try {
    history = await source.cardHistory(card.id);
  } catch (err) {
    options.warn(historyWarning(card.id, err));
    return null;
  }
  let last: DatedChange | null = null;
  for (const change of history) {
    if (change.authorId !== me) continue;
    const atSec = momentOf(change.changed);
    if (
      atSec === null || atSec < options.window.fromSec ||
      atSec > options.window.toSec
    ) {
      continue;
    }
    if (last === null || atSec > last.atSec) {
      last = { columnId: change.columnId, atSec };
    }
  }
  return last;
}

/**
 * Подписи колонок по доскам: доска спрашивается один раз, её отказ
 * запоминается. Отдельного предупреждения у отказа нет — наблюдаемое
 * следствие, id колонки числом, уже описано контрактом (там же,
 * «Известные отклонения», вердикт preserve).
 */
class BoardColumns {
  readonly #source: LiveSource;
  readonly #titles = new Map<number, ReadonlyMap<number, string>>();

  constructor(source: LiveSource) {
    this.#source = source;
  }

  async title(
    boardId: number | null,
    columnId: number | null,
  ): Promise<string> {
    if (columnId === null) return NO_COLUMN;
    if (boardId === null) return String(columnId);
    const known = await this.#board(boardId);
    return known.get(columnId) ?? String(columnId);
  }

  async #board(boardId: number): Promise<ReadonlyMap<number, string>> {
    const known = this.#titles.get(boardId);
    if (known !== undefined) return known;
    const titles = new Map<number, string>();
    try {
      for (const column of await this.#source.boardColumns(boardId)) {
        // Пустое название — то же, что его отсутствие: колонка уйдёт в
        // отчёт id числом, а не пустотой между тире и эмодзи.
        if (column.title !== "") titles.set(column.id, column.title);
      }
    } catch {
      // Недоступная доска — пустая таблица подписей: колонки этой доски
      // печатаются id числом, и это уже сказано контрактом.
    }
    this.#titles.set(boardId, titles);
    return titles;
  }
}

/** Момент из ISO-8601 в epoch-секундах; не разобрался — `null`. */
function momentOf(changed: string | null): number | null {
  if (changed === null) return null;
  const at = Date.parse(changed);
  return Number.isNaN(at) ? null : Math.trunc(at / 1000);
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
