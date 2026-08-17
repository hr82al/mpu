/**
 * Перенос карточки Kaiten в колонку (`docs/specs/kiten-move.md`): резолв
 * цели на доске карточки, решение о релоге, применение и строка
 * локального журнала перемещений.
 *
 * Модуль отдельно от команд, потому что первым его вызывающим стал шаг
 * переноса `mpu kiten close` (`docs/specs/kiten-close.md`), а команда
 * `mpu kiten move` поедет следующей порцией: общей обязана быть
 * механика, а не команда. Отсюда и форма — данные о переносе и функции
 * над ними, без знания о том, из какой команды пришёл вызов.
 */

import type { CacheDb } from "../command/mod.ts";
import { UsageError } from "../command/mod.ts";
import {
  type Card,
  type CardLocation,
  type Column,
  getCard,
  type KaitenAccess,
  moveCard,
} from "../kaiten/mod.ts";

/** Место карточки: ровно то, из чего складывается строка положения. */
export type CardPlace = Pick<
  Card,
  "boardTitle" | "columnTitle" | "laneTitle"
>;

/** Сколько кандидатов показывать при неоднозначном названии. */
const MAX_CANDIDATES = 10;

/** Только цифры — значит id колонки, а не подстрока названия. */
const NUMERIC_REF = /^\d+$/;

/** Что и куда переносится: цель, положение «до» и способ переноса. */
export interface MovePlan {
  readonly columnId: number;
  readonly columnTitle: string;
  /**
   * Карточка уже в целевой колонке, поэтому один PATCH Kaiten молча
   * проигнорирует и перемещение не зафиксируется (`kiten-move.md`).
   */
  readonly relog: boolean;
  /** Положение «до» строкой для вывода. */
  readonly from: string;
}

/** Чем кончился перенос: положения «до» и «после» по свежим чтениям. */
export interface MoveOutcome {
  readonly from: string;
  readonly to: string;
  readonly relog: boolean;
  /** Карточка «после»: из неё же берутся поля строки журнала. */
  readonly card: Card;
}

/**
 * Целевая колонка по ссылке (`platform/kaiten-http.md`, «Резолв
 * справочной ссылки»): числовая ссылка — id, прочая — точное совпадение
 * названия без учёта регистра, иначе подстрока.
 *
 * Числовая ссылка тоже ищется в списке колонок доски, а не берётся как
 * есть: колонка чужой доски карточку не примет, а `close` требует
 * отказать раньше первой мутации (`kiten-close.md`, «Граничные случаи»).
 */
export function resolveColumn(
  columns: readonly Column[],
  ref: string,
): Column {
  if (NUMERIC_REF.test(ref)) {
    const byId = columns.find((column) => column.id === Number(ref));
    if (byId === undefined) throw notFound(ref);
    return byId;
  }
  const needle = ref.toLowerCase();
  const exact = columns.filter((c) => c.title.toLowerCase() === needle);
  // Точное совпадение старше подстроки: «Готово» не должно стать
  // неоднозначным из-за соседнего «Готово к релизу».
  const found = exact.length > 0
    ? exact
    : columns.filter((c) => c.title.toLowerCase().includes(needle));
  if (found.length === 0) throw notFound(ref);
  if (found.length > 1) {
    throw new UsageError(
      `column '${ref}' неоднозначен (${found.length} совпадений):`,
      { details: candidateLines(found) },
    );
  }
  return found[0];
}

/** План переноса: цель уже резолвлена, решение о релоге — по значениям. */
export function planMove(
  card: CardPlace & Pick<Card, "columnId">,
  target: Column,
): MovePlan {
  return {
    columnId: target.id,
    columnTitle: target.title,
    // Решение принимается сравнением значений, а не набором флагов
    // (`kiten-move.md`, «Известные отклонения»).
    relog: card.columnId === target.id,
    from: positionLabel(card),
  };
}

/**
 * Что именно применяется: тело PATCH и надобность релога. Отдельно от
 * плана, потому что планов два — перенос по колонке (`kiten close`) и
 * перенос по трём осям (`mpu kiten move`), — а применение одно.
 */
export interface AppliedMove {
  /** Только заданные оси: незаданная в тело PATCH не попадает. */
  readonly patch: CardLocation;
  /**
   * Целевая колонка релога; `null` — релога нет. Из неё же ищется
   * соседняя колонка для bump.
   */
  readonly relogTarget: number | null;
  /** Положение «до» строкой для вывода. */
  readonly from: string;
}

/** Применение по плану переноса в колонку (`kiten close`). */
export function appliedOf(plan: MovePlan): AppliedMove {
  return {
    patch: { columnId: plan.columnId },
    relogTarget: plan.relog ? plan.columnId : null,
    from: plan.from,
  };
}

/**
 * Применяет перенос и перечитывает карточку: положение «после» несёт
 * только свежий GET — ответ PATCH названий доски, колонки и дорожки не
 * даёт (`kiten-move.md`, «Инварианты»).
 *
 * Релог — два PATCH подряд: в соседнюю колонку и обратно в целевую.
 * Сбой второго оставляет карточку в соседней, отката нет (там же,
 * «Граничные случаи»).
 */
export async function applyMove(
  access: KaitenAccess,
  cardId: number,
  made: AppliedMove,
  columns: readonly Column[],
): Promise<MoveOutcome> {
  if (made.relogTarget !== null) {
    await moveCard(access, cardId, {
      columnId: relogNeighbour(columns, made.relogTarget).id,
    });
  }
  await moveCard(access, cardId, made.patch);
  const after = await getCard(access, cardId);
  return {
    from: made.from,
    to: positionLabel(after),
    relog: made.relogTarget !== null,
    card: after,
  };
}

/**
 * Соседняя колонка для релог-bump: предыдущая по порядку колонок доски,
 * а у крайней левой — следующая справа (`kiten-move.md`, «Релог»).
 */
export function relogNeighbour(
  columns: readonly Column[],
  targetId: number,
): Column {
  const ordered = orderedColumns(columns);
  if (ordered.length < 2) {
    throw new UsageError("на доске одна колонка — релог невозможен");
  }
  const at = ordered.findIndex((column) => column.id === targetId);
  if (at === -1) {
    throw new UsageError("целевая колонка не найдена на доске карточки");
  }
  return at === 0 ? ordered[1] : ordered[at - 1];
}

/**
 * Колонки слева направо: порядок массива его не повторяет, вес даёт
 * `sort_order` (`platform/kaiten-api-refs.md`). Вес не назван — колонка
 * уходит в конец: место без веса впереди сдвинуло бы всю доску.
 */
export function orderedColumns(
  columns: readonly Column[],
): readonly Column[] {
  return [...columns].sort((a, b) => weight(a) - weight(b) || a.id - b.id);
}

/**
 * Положение карточки строкой: непустые названия доски, колонки и
 * дорожки через ` · `; все пусты — прочерк (`kiten-move.md`).
 */
export function positionLabel(card: CardPlace): string {
  const parts = [card.boardTitle, card.columnTitle, card.laneTitle]
    .filter((title): title is string => title !== null && title !== "");
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/** Строка намерения `--dry-run`: что и куда, без единой мутации. */
export function moveDryRunLine(plan: MovePlan): string {
  const what = plan.relog ? "релог (влево→обратно)" : "перемещение";
  return `dry-run: ${what} → «${plan.columnTitle}» (колонка ${plan.columnId}); ` +
    `сейчас ${plan.from}; PATCH не отправлен\n`;
}

/** Куда и откуда переехала карточка — всё, что нужно строке успеха. */
export type MoveMade = Pick<MoveOutcome, "from" | "to" | "relog">;

/** Строка успеха переноса; она же — строка успеха будущего `move`. */
export function moveOkLine(made: MoveMade, cardUrl: string): string {
  const relog = made.relog ? " (релог)" : "";
  return `ok: ${made.from} → ${made.to}${relog} · ${cardUrl}\n`;
}

/** Строка журнала перемещений: состав — «Побочные эффекты» спеки. */
export interface MoveRecord {
  readonly cardId: number;
  readonly title: string;
  readonly url: string;
  /** Название колонки «куда»; пустое — прочерк. */
  readonly toColumn: string;
  /** Название колонки «откуда», по состоянию «до». */
  readonly fromColumn: string | null;
  readonly lane: string | null;
  readonly board: string | null;
  /** Заметка перемещения; у `close` её нет — пустая строка. */
  readonly note: string;
  /** Момент записи, epoch-секунды. */
  readonly movedAt: number;
}

/**
 * Дописывает строку журнала перемещений в кэш-БД. Журнал только
 * пополняется, недостающая схема создаётся на месте (`kiten-move.md`,
 * «Побочные эффекты»); по нему другие команды mpu строят дневную сводку
 * перемещений.
 */
export function recordMove(db: CacheDb, row: MoveRecord): void {
  db.bootstrap();
  db.execute(
    `INSERT INTO kaiten_card_moves
       (card_id, title, url, to_column, from_column, lane, board, note, moved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.cardId,
    row.title,
    row.url,
    row.toColumn,
    row.fromColumn,
    row.lane,
    row.board,
    row.note,
    row.movedAt,
  );
}

/**
 * Строка журнала, как её читает дневная сводка перемещений
 * (`docs/specs/telegram-status.md`, «Ввод/вывод»): из девяти полей ей
 * нужны пять.
 */
export interface LoggedMove {
  readonly cardId: number;
  /** Заголовок карточки; в журнале его может не быть. */
  readonly title: string | null;
  /** Web-URL карточки; пустой — вызывающий строит его сам. */
  readonly url: string | null;
  readonly toColumn: string;
  /** Момент записи, epoch-секунды. */
  readonly movedAt: number;
}

/**
 * Строки журнала, чей момент попал в окно; обе границы включительно.
 * Схема создаётся на месте: сводку зовут и на кэш-БД, в которую ещё
 * никто не писал.
 */
export function movesInWindow(
  db: CacheDb,
  fromSec: number,
  toSec: number,
): readonly LoggedMove[] {
  db.bootstrap();
  const rows = db.query(
    `SELECT card_id, title, url, to_column, moved_at
       FROM kaiten_card_moves
      WHERE moved_at BETWEEN ? AND ?
      ORDER BY moved_at, card_id`,
    fromSec,
    toSec,
  );
  return rows.map((row) => ({
    cardId: Number(row.card_id),
    title: stringOrNull(row.title),
    url: stringOrNull(row.url),
    toColumn: String(row.to_column),
    movedAt: Number(row.moved_at),
  }));
}

/** Пустая ячейка журнала — отсутствие значения, а не пустая строка. */
function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

/** Что о перемещении знает не карточка «после», а сам вызывающий. */
export interface MoveEntry {
  readonly cardUrl: string;
  /** Название колонки «откуда» — по состоянию «до». */
  readonly fromColumn: string | null;
  readonly note: string;
  readonly movedAt: number;
}

/** Строка журнала по карточке «после» и тому, что знает вызывающий. */
export function moveRecordOf(
  outcome: MoveOutcome,
  entry: MoveEntry,
): MoveRecord {
  const card = outcome.card;
  return {
    cardId: card.id,
    title: card.title,
    url: entry.cardUrl,
    toColumn: card.columnTitle === null || card.columnTitle === ""
      ? "—"
      : card.columnTitle,
    fromColumn: entry.fromColumn,
    lane: card.laneTitle,
    board: card.boardTitle,
    note: entry.note,
    movedAt: entry.movedAt,
  };
}

/** Вес колонки для сортировки; веса нет — колонка идёт последней. */
function weight(column: Column): number {
  return column.sortOrder ?? Number.MAX_SAFE_INTEGER;
}

function notFound(ref: string): UsageError {
  return new UsageError(
    `column '${ref}' не найден — см. \`mpu kiten columns\``,
  );
}

/** Кандидаты списком `id (название)`; длинный список обрезается. */
function candidateLines(columns: readonly Column[]): string {
  return columns
    .slice(0, MAX_CANDIDATES)
    .map((column) => `${column.id} (${column.title})`)
    .join("\n");
}
