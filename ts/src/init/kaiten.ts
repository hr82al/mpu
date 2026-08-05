/**
 * HTTP-клиент Kaiten API для прогрева справочников (`docs/specs/init.md`,
 * шаг 4; `docs/specs/platform/kaiten-http.md`, раздел «Прогрев
 * справочников»). Модуль не знает о команде `init` — только о протоколе
 * Kaiten и о таблицах кэша `kaiten_spaces`/`kaiten_boards`/`kaiten_lanes`/
 * `kaiten_columns`/`kaiten_roles` (`platform/store.md`), в которые пишет.
 *
 * Транспорт — общий `httpGet` (`./http.ts`): пределы времени одного
 * вызова и причина сетевого отказа одной строкой там уже решены; здесь —
 * только трактовка протокола Kaiten (пути, заголовки, retry на 429,
 * формат ошибки) и бюджет всего шага целиком (обход досок в частях 2–3).
 */

import {
  DEFAULT_TIMEOUTS,
  HttpCallError,
  httpGet,
  type RequestTimeouts,
} from "./http.ts";
import type { CacheDb } from "../command/mod.ts";

/** Дефолт `KITEN_BASE_URL`, когда переменная не задана (`kaiten-http.md`). */
const DEFAULT_BASE_URL = "https://btlz.kaiten.ru";
/** Единственный автоповторяемый статус — 429, до 6 попыток на запрос. */
const MAX_ATTEMPTS = 6;
/** База и потолок экспоненциального backoff, когда `Retry-After` не пришёл. */
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_CAP_MS = 30_000;
/** Тело ошибки не-2xx обрезается до 300 символов (`kaiten-http.md`). */
const ERROR_BODY_LIMIT = 300;
/** Причина пропуска доски при исчерпании бюджета шага (`init.md`, шаг 4). */
const BUDGET_EXHAUSTED_REASON = "бюджет шага исчерпан";

/** Подключение к Kaiten API. */
export interface KaitenAccess {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Сбой обращения к Kaiten; сообщение — «<причина>» одной строкой. */
export class KaitenError extends Error {
  override name = "KaitenError";
}

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

/** Подключение из env-файла; нет KITEN_API_KEY — KaitenError («KITEN_API_KEY не задан»). */
export function requireKaitenAccess(
  envFile: { readonly get: (name: string) => string | undefined },
): KaitenAccess {
  const apiKey = envFile.get("KITEN_API_KEY");
  if (apiKey === undefined || apiKey === "") {
    throw new KaitenError("KITEN_API_KEY не задан");
  }
  const rawUrl = envFile.get("KITEN_BASE_URL") ?? DEFAULT_BASE_URL;
  // Хвостовые `/` срезаются той же нормализацией, что у `requirePortainerAccess`
  // (`cmd_init.ts`) и `requireLokiAccess` (`loki.ts`): путь строится
  // конкатенацией `baseUrl + "/api/latest" + path`, лишний `/` сложил бы
  // двойной слэш в адресе.
  return { baseUrl: rawUrl.replace(/\/+$/, ""), apiKey };
}

/**
 * Пауза перед повтором 429 в мс: чистая функция расписания, тестируется
 * без сна. `Retry-After` — целое число секунд (`kaiten-http.md`);
 * отсутствие заголовка или нечисловое значение — экспоненциальный backoff
 * 1s, ×2 за попытку, потолок 30s.
 */
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  );
}

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
  // `kaitenGet`: попытки 429 обязаны остаться видимыми, даже если запрос
  // в итоге упал (после исчерпания попыток или из-за бюджета) — при
  // возврате значения только на успехе эти строки терялись бы вместе с
  // отклонённым промисом.
  const spacesNotes: string[] = [];
  const rolesNotes: string[] = [];
  const [spacesOutcome, rolesOutcome] = await Promise.allSettled([
    kaitenGet(access, "/spaces", limits.timeouts, null, nowMs, spacesNotes),
    kaitenGet(access, "/user-roles", limits.timeouts, null, nowMs, rolesNotes),
  ]);

  if (spacesOutcome.status === "rejected") {
    // kaitenGet бросает только KaitenError — сужение вместо `as`, чтобы
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
 * `kaitenGet`: retry-строки упавшей доски не должны теряться вместе с
 * отклонённым промисом (см. комментарий у `kaitenGet`).
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
      kaitenGet(
        access,
        pathFor(board.id),
        timeouts,
        deadlineMs,
        nowMs,
        notesPerBoard[index],
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

/**
 * Один Kaiten GET с retry на 429 (до `MAX_ATTEMPTS` попыток) и учётом
 * бюджета шага. `deadlineMs === null` — вызов без бюджета (части 1 и 4);
 * иначе — предел, после которого ни сам запрос, ни пауза retry не
 * выполняются (`init.md`, шаг 4: «перед выдачей запроса и перед каждой
 * паузой retry проверяется `nowMs() > deadline`»).
 *
 * `notes` — накопитель строк повтора, переданный вызывающим (а не
 * возвращённый вместе с результатом): при исчерпании попыток или
 * срабатывании бюджета функция бросает исключение, и строки о уже
 * прошедших паузах retry обязаны остаться видны потребителю несмотря на
 * это — через возврат только на успехе они терялись бы вместе с
 * отклонённым промисом (см. `collectBoardPart`/`collectKaitenWarmup`).
 */
async function kaitenGet(
  access: KaitenAccess,
  path: string,
  timeouts: RequestTimeouts,
  deadlineMs: number | null,
  nowMs: () => number,
  notes: string[],
): Promise<readonly unknown[]> {
  const url = new URL(`${access.baseUrl}/api/latest${path}`);
  const headers = {
    Authorization: `Bearer ${access.apiKey}`,
    Accept: "application/json",
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    assertBudget(deadlineMs, nowMs);

    let response;
    try {
      response = await httpGet(url, { headers, timeouts });
    } catch (err) {
      // `httpGet` бросает только `HttpCallError` — сообщение уже одной
      // строкой (её собственный инвариант, `http.ts`), поэтому переносится
      // как есть, без повторного прогона через `firstLine`.
      if (!(err instanceof HttpCallError)) throw err;
      throw new KaitenError(err.message, { cause: err });
    }

    if (response.status >= 200 && response.status < 300) {
      return parseItems(path, response.text);
    }

    if (response.status === 429) {
      if (attempt === MAX_ATTEMPTS) {
        throw new KaitenError(`kaiten GET ${path} -> 429: exhausted retries`);
      }
      assertBudget(deadlineMs, nowMs);
      const delayMs = retryDelayMs(attempt, response.retryAfter);
      notes.push(`[kaiten] 429 rate-limit, sleep ${delayMs / 1000}s`);
      await sleep(delayMs);
      continue;
    }

    throw new KaitenError(
      `kaiten GET ${path} -> ${response.status}: ${
        truncateBody(response.text)
      }`,
    );
  }
  // Недостижимо: цикл на каждой итерации либо возвращает, либо бросает —
  // но `for` не даёт компилятору это увидеть, а без завершающего throw
  // функция не проходит проверку «не все пути возвращают значение».
  throw new KaitenError(`kaiten GET ${path} -> 429: exhausted retries`);
}

/** Бросает `KaitenError` с причиной бюджета, если дедлайн уже прошёл. */
function assertBudget(deadlineMs: number | null, nowMs: () => number): void {
  if (deadlineMs !== null && nowMs() > deadlineMs) {
    throw new KaitenError(BUDGET_EXHAUSTED_REASON);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateBody(text: string): string {
  return text.length > ERROR_BODY_LIMIT
    ? text.slice(0, ERROR_BODY_LIMIT)
    : text;
}

/** Причина отказа одной строкой: у наших ошибок это всегда `message`. */
function reasonOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Тело успешного ответа как список сырых элементов. Не-JSON — ошибка
 * (форма ответа испорчена, отличие от Loki: там пустой результат считается
 * штатным — здесь пустой каталог справочника не отличить от испорченного
 * ответа, поэтому испорченный JSON остаётся ошибкой). Тело-не-массив —
 * не ошибка, а пустой список (`init.md`, шаг 4: «тело не-массив — трактуй
 * как пустой массив»).
 */
function parseItems(path: string, text: string): readonly unknown[] {
  if (text.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new KaitenError(`kaiten GET ${path}: ответ не JSON`, { cause: err });
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** Значение — объект-запись (не массив, не `null`, не примитив). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Число как есть либо `null` — элементы без числового id пропускаются. */
function numericId(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
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
