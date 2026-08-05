/**
 * Снапшот кэш-БД (`docs/specs/update.md`): формы строк трёх таблиц
 * снапшота, разбор выборок PG в эти формы и запись — полное замещение
 * одной транзакцией либо точечный upsert одного клиента.
 *
 * Модуль знает о SQLite-стороне и о том, как выглядят выборки PG, но не
 * о том, откуда они взялись: подключения, таймауты и конкурентность —
 * дело `sync.ts`.
 */

import type { CacheDb } from "../command/mod.ts";

/** Значение колонки в выборке PG. */
export type PgValue = string | number | boolean | null;

/** Строка выборки PG: имя колонки → значение. */
export type PgRow = Readonly<Record<string, PgValue>>;

/** Строка `sl_clients`. */
export interface ClientRow {
  readonly clientId: number;
  readonly server: string | null;
  readonly isActive: number;
  readonly isLocked: number;
  readonly isDeleted: number;
}

/** Строка `sl_spreadsheets`. */
export interface SpreadsheetRow {
  readonly ssId: string;
  readonly clientId: number;
  readonly title: string;
  readonly templateName: string | null;
  readonly isActive: number;
  readonly server: string | null;
}

/** Строка `sl_wb_sids`. */
export interface WbSidRow {
  readonly sid: string;
  readonly clientId: number;
  readonly server: string | null;
}

/** Снапшот одного прогона: содержимое трёх таблиц целиком. */
export interface Snapshot {
  readonly clients: readonly ClientRow[];
  readonly spreadsheets: readonly SpreadsheetRow[];
  readonly wbSids: readonly WbSidRow[];
}

/**
 * Выборка PG отдала строку не той формы, что обещает спека (нет колонки
 * либо в ней не то значение). Отдельный класс, а не общий `Error`:
 * для инстанса это сбой одного сервера (best-effort), для main — отказ
 * команды, и различать их приходится по типу, а не по тексту.
 */
export class PgRowError extends Error {
  override name = "PgRowError";
}

/** Строки `public.clients` (шаг 1) в форме кэша. */
export function readClientRows(rows: readonly PgRow[]): readonly ClientRow[] {
  return rows.map((row) => ({
    clientId: intOf(row.id, "clients.id"),
    server: textOf(row.server),
    isActive: flagOf(row.is_active),
    isLocked: flagOf(row.is_locked),
    isDeleted: flagOf(row.is_deleted),
  }));
}

/**
 * Строки `public.spreadsheets` (шаг 2) в форме кэша; `server` — имя
 * сервера, с которого они пришли (полный синк — `sl-<N>`, точечный —
 * исходная строка `server` клиента).
 */
export function readSpreadsheetRows(
  rows: readonly PgRow[],
  server: string | null,
): readonly SpreadsheetRow[] {
  return rows.map((row) => ({
    ssId: stringOf(row.spreadsheet_id, "spreadsheets.spreadsheet_id"),
    clientId: intOf(row.client_id, "spreadsheets.client_id"),
    // Пустой или NULL заголовок ложится пустой строкой (спека, «Запись»):
    // колонка кэша объявлена NOT NULL.
    title: textOf(row.title) ?? "",
    templateName: textOf(row.template_name),
    isActive: flagOf(row.is_active),
    server,
  }));
}

/**
 * Строки `public.wb_tokens` (шаг 3) в форме кэша. Sid клиента, которого
 * нет в выборке шага 1, отбрасывается молча (инвариант спеки: «sid без
 * клиента в текущей выборке не пишется никогда»), а имя сервера берётся
 * у его клиента — своего у выборки sid'ов нет.
 */
export function readWbSidRows(
  rows: readonly PgRow[],
  clients: readonly ClientRow[],
): readonly WbSidRow[] {
  const serverOf = new Map(clients.map((c) => [c.clientId, c.server]));
  const out: WbSidRow[] = [];
  for (const row of rows) {
    const clientId = intOf(row.client_id, "wb_tokens.client_id");
    const server = serverOf.get(clientId);
    if (server === undefined) continue;
    out.push({ sid: stringOf(row.sid, "wb_tokens.sid"), clientId, server });
  }
  return out;
}

/**
 * Полное замещение трёх таблиц снапшота одной транзакцией. Bootstrap
 * предваряет запись (`platform/store.md`) — он же self-heal кэша,
 * потерявшего часть таблиц. Прерывание внутри транзакции не оставляет
 * частичного снапшота: DELETE и вставки фиксируются вместе.
 */
export function writeSnapshot(
  db: CacheDb,
  snapshot: Snapshot,
  syncedAt: number,
): void {
  db.bootstrap();
  db.transaction(() => {
    db.execute("DELETE FROM sl_clients");
    db.execute("DELETE FROM sl_spreadsheets");
    db.execute("DELETE FROM sl_wb_sids");
    for (const client of snapshot.clients) insertClient(db, client, syncedAt);
    for (const row of snapshot.spreadsheets) {
      insertSpreadsheet(db, row, syncedAt);
    }
    for (const row of snapshot.wbSids) insertWbSid(db, row, syncedAt);
  });
}

/** Части точечного синка; `null` — часть не выполнена, её строки не трогаем. */
export interface ClientSnapshot {
  readonly client: ClientRow;
  readonly spreadsheets: readonly SpreadsheetRow[] | null;
  readonly wbSids: readonly WbSidRow[] | null;
}

/**
 * Точечный синк одного клиента: upsert его строк одной транзакцией.
 * Соседние клиенты не затрагиваются, а строки самого клиента,
 * исчезнувшие из выборки, не удаляются — их вычищает полный синк
 * (`update.md`, «Точечный синк»).
 */
export function upsertClient(
  db: CacheDb,
  snapshot: ClientSnapshot,
  syncedAt: number,
): void {
  db.bootstrap();
  db.transaction(() => {
    insertClient(db, snapshot.client, syncedAt);
    for (const row of snapshot.spreadsheets ?? []) {
      insertSpreadsheet(db, row, syncedAt);
    }
    for (const row of snapshot.wbSids ?? []) insertWbSid(db, row, syncedAt);
  });
}

const UPSERT_CLIENT_SQL = `
  INSERT INTO sl_clients (client_id, server, is_active, is_locked, is_deleted,
    synced_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(client_id) DO UPDATE SET
    server = excluded.server,
    is_active = excluded.is_active,
    is_locked = excluded.is_locked,
    is_deleted = excluded.is_deleted,
    synced_at = excluded.synced_at
`;

const UPSERT_SPREADSHEET_SQL = `
  INSERT INTO sl_spreadsheets (ss_id, client_id, title, template_name,
    is_active, server, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ss_id) DO UPDATE SET
    client_id = excluded.client_id,
    title = excluded.title,
    template_name = excluded.template_name,
    is_active = excluded.is_active,
    server = excluded.server,
    synced_at = excluded.synced_at
`;

const UPSERT_WB_SID_SQL = `
  INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(sid, client_id) DO UPDATE SET
    server = excluded.server,
    synced_at = excluded.synced_at
`;

// Полное замещение и точечный upsert пишут строку одним и тем же
// оператором: у полного замещения конфликта не бывает (таблица только
// что очищена), а два разных INSERT'а на одну таблицу разошлись бы по
// составу колонок при первой же правке.
function insertClient(db: CacheDb, row: ClientRow, syncedAt: number): void {
  db.execute(
    UPSERT_CLIENT_SQL,
    row.clientId,
    row.server,
    row.isActive,
    row.isLocked,
    row.isDeleted,
    syncedAt,
  );
}

function insertSpreadsheet(
  db: CacheDb,
  row: SpreadsheetRow,
  syncedAt: number,
): void {
  db.execute(
    UPSERT_SPREADSHEET_SQL,
    row.ssId,
    row.clientId,
    row.title,
    row.templateName,
    row.isActive,
    row.server,
    syncedAt,
  );
}

function insertWbSid(db: CacheDb, row: WbSidRow, syncedAt: number): void {
  db.execute(UPSERT_WB_SID_SQL, row.sid, row.clientId, row.server, syncedAt);
}

/** Целое из значения колонки; иное — `PgRowError` с именем колонки. */
function intOf(value: PgValue, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new PgRowError(`${column}: ожидалось целое, пришло ${show(value)}`);
  }
  return parsed;
}

/** Непустая строка из значения колонки; иное — `PgRowError`. */
function stringOf(value: PgValue, column: string): string {
  if (typeof value !== "string" || value === "") {
    throw new PgRowError(`${column}: ожидалась строка, пришло ${show(value)}`);
  }
  return value;
}

/** Текст колонки; NULL — `null`. Числа и флаги приводятся к тексту. */
function textOf(value: PgValue): string | null {
  return value === null ? null : String(value);
}

/**
 * Флаг PG в целое кэша: колонки `is_*` объявлены в кэше INTEGER, а
 * драйвер отдаёт boolean. Всё, что не «истина», — 0: NULL в кэше
 * недопустим (колонки NOT NULL), а «неизвестно» и «нет» для этих
 * признаков различий не имеют.
 */
function flagOf(value: PgValue): number {
  return value === true || value === 1 ? 1 : 0;
}

/**
 * Значение колонки в сообщении об ошибке. `?? "undefined"` — не
 * перестраховка: колонки в строке может не оказаться вовсе, и тогда
 * сюда приходит `undefined`, которого `JSON.stringify` не сериализует.
 */
function show(value: PgValue): string {
  return JSON.stringify(value) ?? "undefined";
}
