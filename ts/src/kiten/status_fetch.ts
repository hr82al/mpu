/**
 * Сбор данных `mpu kiten status` (`docs/specs/kiten-status.md`, шаги
 * 1–8): три источника, дозагрузка названий колонок и перепроверка
 * карточек, попавших в выдачу единственным комментарием.
 *
 * Порядок и границы окон здесь же, потому что они наблюдаемы: окно
 * `--since` решает, что попало в выдачу, а `--time-since` — только
 * сумму колонки ВРЕМЯ, и путать их нельзя.
 */

import type { CacheDb } from "../command/mod.ts";
import type {
  Activity,
  CardSummary,
  Column,
  TimeLogCard,
  UserTimeLog,
} from "../kaiten/mod.ts";
import { stateLabel } from "./card_view.ts";
import type { StatusInput, StatusSource } from "./status_data.ts";

/** Действия ленты, из которых строится источник `activity` (спека). */
export const FEED_ACTIONS: readonly string[] = [
  "card_add",
  "card_move",
  "card_archive",
  "comment_add",
  "card_assign_responsible",
  "card_assign_member",
];

/** Потолок страниц ленты: недели окна × 3, но не больше двенадцати. */
export function feedPageCap(sinceSeconds: number, nowSeconds: number): number {
  const weeks = (nowSeconds - sinceSeconds) / (7 * 86_400);
  return Math.min(12, Math.max(1, Math.round(weeks)) * 3);
}

/** Вызовы Kaiten, нужные сбору; в тестах подменяются целиком. */
export interface StatusApi {
  readonly cardsOfMember: () => Promise<readonly CardSummary[]>;
  readonly cardsOfResponsible: () => Promise<readonly CardSummary[]>;
  readonly timeLogs: () => Promise<readonly UserTimeLog[]>;
  readonly activities: (maxPages: number) => Promise<readonly Activity[]>;
  /** Комментарии карточки: перепроверка единственного `comment_add`. */
  readonly commentsOf: (cardId: number) => Promise<readonly CommentAuthor[]>;
  /** Колонки доски: дозагрузка названий, которых нет в кэше. */
  readonly columnsOf: (boardId: number) => Promise<readonly Column[]>;
}

/** Автор комментария — всё, что нужно перепроверке. */
export interface CommentAuthor {
  readonly authorId: number;
}

/**
 * Названия колонок досок, которых не хватило: вызывается один раз,
 * между сбором версий и их слиянием. Ходит в сеть и пишет кэш, поэтому
 * подставляется командой, а не собирается здесь.
 */
export type TitleResolver = (
  boardIds: readonly number[],
) => Promise<Readonly<Record<number, string>>>;

/** Окна сбора в unix-секундах. */
export interface StatusWindows {
  readonly since: number;
  readonly timeSince: number;
  readonly now: number;
}

/** Итог сбора: версии карточек, минуты и признак неполной ленты. */
export interface StatusHarvest {
  readonly inputs: readonly StatusInput[];
  readonly minutes: Readonly<Record<number, number>>;
  /**
   * Сумма минут окна `--since` по ролям записей — для подвала
   * человекочитаемых форм. Роль записи бывает не задана: такие минуты
   * идут под ключом `без роли`.
   */
  readonly minutesByRole: Readonly<Record<string, number>>;
  /** Самое старое прочитанное событие ленты; лента пуста — `null`. */
  readonly oldestFeedAt: string | null;
  /** Прочитана ли лента до начала окна: иначе выдача может быть неполной. */
  readonly feedComplete: boolean;
}

/**
 * Как карточка выглядит для слияния: одна форма на все три источника.
 * Формы источников разные — из ленты приходит `CardSummary`, из записей
 * времени её усечённый вариант с необязательными полями, — и сводить их
 * приходится здесь, до всякого слияния.
 */
function inputOf(
  card: {
    readonly id: number;
    readonly title: string | null;
    readonly state: number | null;
    readonly condition: number | null;
    readonly dueDate: string | null;
    readonly updated: string | null;
    readonly columnId: number | null;
    readonly archived: boolean | null;
    readonly boardTitle: string | null;
    readonly columnTitle: string | null;
    readonly laneTitle: string | null;
    readonly spaceTitle: string | null;
    readonly boardId: number | null;
  },
  source: StatusSource,
  columnTitles: Readonly<Record<number, string>>,
  url: (cardId: number) => string,
): StatusInput {
  const column = card.columnTitle ??
    (card.columnId === null ? null : columnTitles[card.columnId] ?? null);
  return {
    id: card.id,
    title: card.title ?? "",
    url: url(card.id),
    column,
    board: card.boardTitle,
    space: card.spaceTitle,
    lane: card.laneTitle,
    state: card.state === null ? null : stateLabel(card.state),
    condition: card.condition,
    archived: card.archived === true,
    dueDate: card.dueDate,
    updated: card.updated,
    source,
  };
}

/** Карточка ответа `/cards` в общей форме: у неё пространств список. */
function ofSummary(card: CardSummary) {
  return { ...card, spaceTitle: card.spaceTitles[0] ?? null };
}

/** Карточка записи времени: id обязателен, остальное бывает пустым. */
function ofTimeLog(card: TimeLogCard, cardId: number) {
  return { ...card, id: cardId };
}

/**
 * Собирает три источника. Живой сети здесь нет: вызовы приходят
 * готовыми, и порядок их применения — единственное, что проверяется.
 */
export async function harvest(
  api: StatusApi,
  windows: StatusWindows,
  myId: number,
  url: (cardId: number) => string,
  resolveTitles: TitleResolver = () => Promise.resolve({}),
): Promise<StatusHarvest> {
  const collected: {
    readonly card: Parameters<typeof inputOf>[0];
    readonly source: StatusSource;
  }[] = [];

  const [members, responsible] = await Promise.all([
    api.cardsOfMember(),
    api.cardsOfResponsible(),
  ]);
  for (const card of [...members, ...responsible]) {
    collected.push({ card: ofSummary(card), source: "assigned" });
  }

  const logs = await api.timeLogs();
  const minutes: Record<number, number> = {};
  const minutesByRole: Record<string, number> = {};
  const touchedByTime = new Set<number>();
  for (const log of logs) {
    // Сумма — по всему окну `--time-since`; источником карточка
    // становится только записью внутри окна `--since` (спека, шаг 3).
    minutes[log.cardId] = (minutes[log.cardId] ?? 0) + log.timeSpent;
    if (dayOf(log.forDate) >= dayOf(windows.since)) {
      touchedByTime.add(log.cardId);
      // Подвал показывает время окна `--since`, а не всей суммы: это
      // «сколько я списал за период», а не «сколько на карточках всего».
      const role = log.roleName ?? "без роли";
      minutesByRole[role] = (minutesByRole[role] ?? 0) + log.timeSpent;
    }
  }
  for (const log of logs) {
    if (log.card === null || !touchedByTime.has(log.cardId)) continue;
    collected.push({
      card: ofTimeLog(log.card, log.cardId),
      source: "time",
    });
    touchedByTime.delete(log.cardId);
  }

  const activities = await api.activities(
    feedPageCap(windows.since, windows.now),
  );
  const commentOnly = new Map<number, boolean>();
  let oldestFeedAt: string | null = null;
  for (const event of activities) {
    if (event.created !== null) {
      if (oldestFeedAt === null || event.created < oldestFeedAt) {
        oldestFeedAt = event.created;
      }
    }
    if (event.card === null) continue;
    if (momentOf(event.created) < windows.since) continue;
    collected.push({ card: ofSummary(event.card), source: "activity" });
    const onlyComment = commentOnly.get(event.card.id);
    commentOnly.set(
      event.card.id,
      event.action === "comment_add" && onlyComment !== false,
    );
  }

  // Названия колонок — вторым проходом: доски известны только теперь, а
  // дозагрузка недостающих ходит в сеть и пишет кэш (спека, шаг 8).
  const unknown = collected
    .filter((item) => item.card.columnTitle === null)
    .map((item) => item.card.boardId)
    .filter((boardId): boardId is number => boardId !== null);
  const columnTitles = await resolveTitles(unknown);
  const inputs = collected.map((item) =>
    inputOf(item.card, item.source, columnTitles, url)
  );

  const dropped = await droppedComments(api, inputs, commentOnly, myId);
  return {
    inputs: inputs.filter((input) => !dropped.has(input.id)),
    minutes,
    minutesByRole,
    oldestFeedAt,
    feedComplete: oldestFeedAt === null ||
      momentOf(oldestFeedAt) <= windows.since,
  };
}

/**
 * Карточки, попавшие в выдачу ТОЛЬКО событием `comment_add` и только из
 * ленты: если моего комментария на карточке нет (удалён), строка
 * отбрасывается. Проверка не удалась — строка остаётся: молчаливая
 * потеря хуже лишней строки (спека, шаг 7).
 */
async function droppedComments(
  api: StatusApi,
  inputs: readonly StatusInput[],
  commentOnly: ReadonlyMap<number, boolean>,
  myId: number,
): Promise<ReadonlySet<number>> {
  const feedOnly = new Set<number>();
  for (const [cardId, onlyComment] of commentOnly) {
    if (!onlyComment) continue;
    const sources = new Set(
      inputs.filter((input) => input.id === cardId).map((input) =>
        input.source
      ),
    );
    if (sources.size === 1 && sources.has("activity")) feedOnly.add(cardId);
  }
  const dropped = new Set<number>();
  for (const cardId of feedOnly) {
    try {
      const comments = await api.commentsOf(cardId);
      if (!comments.some((comment) => comment.authorId === myId)) {
        dropped.add(cardId);
      }
    } catch {
      // Проверка не удалась — строку оставляем (спека, шаг 7).
    }
  }
  return dropped;
}

/**
 * Названия колонок из кэша справочника; доски, которых в кэше нет,
 * дозагружаются и записываются туда же (спека, шаг 8). Не удалось —
 * названия не будет, и этап строки станет `—`, а не отказом команды.
 */
export async function columnTitlesFor(
  db: CacheDb,
  api: Pick<StatusApi, "columnsOf">,
  boardIds: readonly number[],
  writeColumns: (boardId: number, columns: readonly Column[]) => void,
): Promise<Readonly<Record<number, string>>> {
  const titles: Record<number, string> = {};
  const known = new Set<number>();
  for (
    const row of db.query("SELECT id, board_id, title FROM kaiten_columns")
  ) {
    const id = row.id;
    const boardId = row.board_id;
    if (typeof id !== "number" || typeof row.title !== "string") continue;
    titles[id] = row.title;
    if (typeof boardId === "number") known.add(boardId);
  }
  for (const boardId of new Set(boardIds)) {
    if (known.has(boardId)) continue;
    try {
      const columns = await api.columnsOf(boardId);
      for (const column of columns) titles[column.id] = column.title;
      writeColumns(boardId, columns);
    } catch {
      // Доска недоступна — её колонки останутся неизвестными; этап
      // таких строк будет `—` (спека, шаг 8).
    }
  }
  return titles;
}

/** Начало суток момента: окна спеки считаются по дням. */
function dayOf(value: string | number | null): number {
  const seconds = typeof value === "number" ? value : momentOf(value);
  return Math.floor(seconds / 86_400);
}

/** Момент ISO-строки в unix-секундах; нечитаемо — ноль. */
function momentOf(value: string | null): number {
  const parsed = value === null ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}
