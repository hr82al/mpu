/**
 * Прогрев справочников Kaiten (`docs/specs/platform/kaiten-http.md`,
 * раздел «Прогрев справочников»; `docs/specs/init.md`, шаг 4): четыре
 * независимые best-effort части и запись каждой в свою таблицу кэша
 * (`platform/store.md`).
 *
 * О команде `init` файл не знает — только о протоколе Kaiten и о
 * таблицах `kaiten_spaces`/`kaiten_boards`/`kaiten_lanes`/
 * `kaiten_columns`/`kaiten_roles`, в которые пишет. Транспорт (доступ,
 * retry, формат ошибки) — `./http.ts`; здесь — состав прогрева и
 * бюджет шага целиком (обход досок в частях 2–3).
 */

import { DEFAULT_TIMEOUTS, type RequestTimeouts } from "../http/mod.ts";
import type { CacheDb } from "../command/mod.ts";
import {
  isRecord,
  type KaitenAccess,
  kaitenCallArray,
  KaitenError,
  numericId,
  stringOr,
} from "./http.ts";

export interface KaitenSpace {
  readonly id: number;
  readonly title: string;
  readonly archived: boolean;
}

export interface KaitenBoard {
  readonly id: number;
  readonly spaceId: number;
  readonly title: string;
}

/** Строка дорожки или колонки: у обеих один набор полей. */
export interface BoardRow {
  readonly id: number;
  readonly boardId: number;
  readonly title: string;
}

export interface KaitenRole {
  readonly id: number;
  readonly name: string;
}

/** Пропуск одной доски в частях 2–3: причина видна потребителю. */
export interface BoardSkip {
  readonly boardId: number;
  readonly reason: string;
}

/** Собранное по обойдённым доскам: замена строк только этих досок. */
export interface BoardRows {
  readonly boardIds: readonly number[];
  readonly rows: readonly BoardRow[];
}

/** Итог прогрева. `null` у части — она упала целиком (в сводке init её счётчик `?`). */
export interface KaitenWarmup {
  readonly spaces: readonly KaitenSpace[];
  readonly boards: readonly KaitenBoard[];
  readonly lanes: BoardRows | null;
  readonly columns: BoardRows | null;
  readonly roles: readonly KaitenRole[] | null;
  /** Строки `# kaiten: доска <id>: пропущена (<причина>)` собирает потребитель — здесь только данные. */
  readonly skips: readonly BoardSkip[];
  /** Служебные строки атома, которые потребитель печатает как есть (retry 429). */
  readonly notes: readonly string[];
}

/** Пределы шага. */
export interface KaitenLimits {
  readonly timeouts: RequestTimeouts;
  /** Бюджет шага в мс: паузы retry его не отменяют (`init.md`, шаг 4). */
  readonly budgetMs: number;
}

/** Бюджет шага по умолчанию; число видно в `--help` init. */
export const WARMUP_BUDGET_MS = 20_000;

/** Пределы прогрева по умолчанию: числа названы в `--help` команды init. */
export const DEFAULT_KAITEN_LIMITS: KaitenLimits = {
  timeouts: DEFAULT_TIMEOUTS,
  budgetMs: WARMUP_BUDGET_MS,
};

/**
 * Прогрев: части 1 и 4 конкурентно, затем части 2 и 3 конкурентно по
 * доскам. Ошибка части 1 (нет списка досок) бросает `KaitenError` и
 * отменяет части 2–3 целиком; ошибка части 4 не трогает остальные —
 * `roles` становится `null`. Бюджет шага (`limits.budgetMs`) ограничивает
 * только обход досок: части 1 и 4 бюджет не проверяют — они всегда нужны
 * целиком, и им попросту нечего «частично пропустить» (в отличие от
 * доски, у частей 1 и 4 нет меньшей единицы работы).
 */
export async function collectKaitenWarmup(
  access: KaitenAccess,
  limits: KaitenLimits = DEFAULT_KAITEN_LIMITS,
  nowMs: () => number = Date.now,
): Promise<KaitenWarmup> {
  const deadlineMs = nowMs() + limits.budgetMs;

  // `notes` — мутируемые накопители retry-строк, переданные внутрь
  // вызова: попытки 429 обязаны остаться видимыми, даже если запрос
  // в итоге упал (после исчерпания попыток или из-за бюджета) — при
  // возврате значения только на успехе эти строки терялись бы вместе с
  // отклонённым промисом.
  const spacesNotes: string[] = [];
  const rolesNotes: string[] = [];
  const [spacesOutcome, rolesOutcome] = await Promise.allSettled([
    kaitenCallArray(access, { method: "GET", path: "/spaces" }, {
      timeouts: limits.timeouts,
      notes: spacesNotes,
    }),
    kaitenCallArray(access, { method: "GET", path: "/user-roles" }, {
      timeouts: limits.timeouts,
      notes: rolesNotes,
    }),
  ]);

  if (spacesOutcome.status === "rejected") {
    // Вызов бросает только KaitenError — сужение вместо `as`, чтобы
    // не терять cause-цепочку исходной ошибки.
    throw spacesOutcome.reason instanceof KaitenError
      ? spacesOutcome.reason
      : new KaitenError(reasonOf(spacesOutcome.reason));
  }
  const { spaces, boards } = parseSpaces(spacesOutcome.value);

  const notes: string[] = [...spacesNotes, ...rolesNotes];
  const roles = rolesOutcome.status === "fulfilled"
    ? parseRoles(rolesOutcome.value)
    : null;

  const [lanesPart, columnsPart] = await Promise.all([
    collectBoardPart(
      access,
      boards,
      (id) => `/boards/${id}/lanes`,
      limits.timeouts,
      deadlineMs,
      nowMs,
    ),
    collectBoardPart(
      access,
      boards,
      (id) => `/boards/${id}/columns`,
      limits.timeouts,
      deadlineMs,
      nowMs,
    ),
  ]);
  notes.push(...lanesPart.notes, ...columnsPart.notes);

  return {
    spaces,
    boards,
    lanes: lanesPart.rows,
    columns: columnsPart.rows,
    roles,
    skips: [...lanesPart.skips, ...columnsPart.skips],
    notes,
  };
}

/**
 * Записывает собранное в кэш-БД; каждая часть — своя транзакция
 * (`kaiten-http.md`: ошибка записи одной части не трогает остальные).
 * Части 2–3 (`lanes`/`columns`) при `null` таблицу не трогают вовсе —
 * `null` означает «часть упала целиком», а не «досок не найдено».
 */
export function writeKaitenWarmup(
  db: CacheDb,
  warmup: KaitenWarmup,
  discoveredAt: number,
): void {
  // Часть 1: пространства и доски — одна транзакция на обе таблицы
  // (kaiten-http.md, «Прогрев справочников», п.1).
  db.transaction(() => {
    db.execute("DELETE FROM kaiten_spaces");
    for (const space of warmup.spaces) {
      db.execute(
        "INSERT INTO kaiten_spaces (id, title, archived, discovered_at) VALUES (?, ?, ?, ?)",
        space.id,
        space.title,
        space.archived ? 1 : 0,
        discoveredAt,
      );
    }
    db.execute("DELETE FROM kaiten_boards");
    for (const board of warmup.boards) {
      db.execute(
        "INSERT INTO kaiten_boards (id, space_id, title, discovered_at) VALUES (?, ?, ?, ?)",
        board.id,
        board.spaceId,
        board.title,
        discoveredAt,
      );
    }
  });

  writeBoardRows(db, "kaiten_lanes", warmup.lanes, discoveredAt);
  writeBoardRows(db, "kaiten_columns", warmup.columns, discoveredAt);

  // Часть 4: роли — своя транзакция; `null` (часть упала) таблицу не трогает.
  const roles = warmup.roles;
  if (roles !== null) {
    db.transaction(() => {
      db.execute("DELETE FROM kaiten_roles");
      for (const role of roles) {
        db.execute(
          "INSERT INTO kaiten_roles (id, name, discovered_at) VALUES (?, ?, ?)",
          role.id,
          role.name,
          discoveredAt,
        );
      }
    });
  }
}

/**
 * Scoped-замена одной таблицы дорожек/колонок: удаляются и переписываются
 * только строки обойдённых досок (`data.boardIds`) — кэш остальных досок
 * не трогается (`kaiten-http.md`: «частичный рефреш не стирает кэш
 * остальных досок»). `data === null` — часть упала целиком, таблица не
 * трогается вовсе (в отличие от `{ boardIds: [], rows: [] }` — пустого,
 * но успешного обхода нулевых досок).
 */
function writeBoardRows(
  db: CacheDb,
  table: "kaiten_lanes" | "kaiten_columns",
  data: BoardRows | null,
  discoveredAt: number,
): void {
  if (data === null) return;
  db.transaction(() => {
    for (const boardId of data.boardIds) {
      db.execute(`DELETE FROM ${table} WHERE board_id = ?`, boardId);
    }
    for (const row of data.rows) {
      db.execute(
        `INSERT INTO ${table} (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)`,
        row.id,
        row.boardId,
        row.title,
        discoveredAt,
      );
    }
  });
}

/** Итог обхода досок одной части (дорожки либо колонки). */
interface BoardPartOutcome {
  readonly rows: BoardRows | null;
  readonly skips: readonly BoardSkip[];
  readonly notes: readonly string[];
}

/**
 * Обходит доски конкурентно (`Promise.allSettled`) для одной части:
 * ошибка одной доски не прерывает остальные (отклонение-fix атома) и
 * попадает в `skips`, а не проходит молча. Часть становится `null`,
 * только когда досок было больше нуля и ни одна не обошлась
 * (`kaiten-http.md`); пустой список досок даёт пустой, но не `null` итог.
 *
 * `notes` собирается в общий мутируемый массив, переданный каждому
 * вызову: retry-строки упавшей доски не должны теряться вместе с
 * отклонённым промисом (см. `KaitenCallOptions` в `./http.ts`).
 */
async function collectBoardPart(
  access: KaitenAccess,
  boards: readonly KaitenBoard[],
  pathFor: (boardId: number) => string,
  timeouts: RequestTimeouts,
  deadlineMs: number,
  nowMs: () => number,
): Promise<BoardPartOutcome> {
  if (boards.length === 0) {
    return { rows: { boardIds: [], rows: [] }, skips: [], notes: [] };
  }

  // Накопитель на каждую доску, а не один общий: доски опрашиваются
  // конкурентно, и в общий массив строки повторов ложились бы в порядке
  // ответов сервера. Порядок вывода обязан зависеть только от порядка
  // досок (`init.md`: конкурентность ненаблюдаема ничем, кроме времени),
  // поэтому склейка идёт по индексу доски уже после обхода.
  const notesPerBoard = boards.map((): string[] => []);
  const outcomes = await Promise.allSettled(
    boards.map((board, index) =>
      kaitenCallArray(
        access,
        { method: "GET", path: pathFor(board.id) },
        {
          timeouts,
          deadlineMs,
          nowMs,
          notes: notesPerBoard[index],
        },
      )
    ),
  );

  const boardIds: number[] = [];
  const rows: BoardRow[] = [];
  const skips: BoardSkip[] = [];
  outcomes.forEach((outcome, index) => {
    const board = boards[index];
    if (outcome.status === "rejected") {
      skips.push({ boardId: board.id, reason: reasonOf(outcome.reason) });
      return;
    }
    boardIds.push(board.id);
    rows.push(...parseBoardRows(outcome.value));
  });

  return {
    rows: boardIds.length === 0 ? null : { boardIds, rows },
    skips,
    notes: notesPerBoard.flat(),
  };
}

/** Причина отказа одной строкой: у наших ошибок это всегда `message`. */
function reasonOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Разбор ответа части 1: пространства и вложенные в них доски. */
function parseSpaces(raw: readonly unknown[]): {
  readonly spaces: readonly KaitenSpace[];
  readonly boards: readonly KaitenBoard[];
} {
  const spaces: KaitenSpace[] = [];
  const boards: KaitenBoard[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = numericId(item.id);
    if (id === null) continue;
    spaces.push({
      id,
      title: stringOr(item.title, ""),
      archived: item.archived === true,
    });

    const rawBoards = Array.isArray(item.boards) ? item.boards : [];
    for (const board of rawBoards) {
      if (!isRecord(board)) continue;
      const boardId = numericId(board.id);
      if (boardId === null) continue;
      boards.push({
        id: boardId,
        // `space_id` приходит в каждой вложенной доске (`kaiten-http.md`);
        // родительский id — запасной случай на неполный элемент.
        spaceId: numericId(board.space_id) ?? id,
        title: stringOr(board.title, ""),
      });
    }
  }
  return { spaces, boards };
}

/** Разбор ответа частей 2–3: общая форма `{id, board_id, title}` дорожки/колонки. */
function parseBoardRows(raw: readonly unknown[]): readonly BoardRow[] {
  const rows: BoardRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = numericId(item.id);
    const boardId = numericId(item.board_id);
    if (id === null || boardId === null) continue;
    rows.push({ id, boardId, title: stringOr(item.title, "") });
  }
  return rows;
}

/** Разбор ответа части 4: роли `{id, name}`. */
function parseRoles(raw: readonly unknown[]): readonly KaitenRole[] {
  const roles: KaitenRole[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = numericId(item.id);
    if (id === null) continue;
    roles.push({ id, name: stringOr(item.name, "") });
  }
  return roles;
}
