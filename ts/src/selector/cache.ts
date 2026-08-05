/**
 * Чтение кандидатов из локальной кэш-БД (`platform/store.md`) для резолва
 * селектора: клиенты и их таблицы, sid'ы, кэш email→клиент. Резолв
 * идемпотентен, поэтому интерфейс потребителя — одно только чтение
 * (`docs/specs/platform/selector.md`, «Побочные эффекты»).
 */

import type { SqlParam, SqlRow } from "../command/mod.ts";
import { type Candidate, serverNumberOf } from "./candidate.ts";
import { SelectorError } from "./error.ts";

/** Кэш-БД глазами резолва: чтение и ничего больше. */
export interface CacheReader {
  readonly query: (sql: string, ...params: SqlParam[]) => readonly SqlRow[];
}

/**
 * Таблицы, которые читает резолв. Их отсутствие — не «ничего не нашли», а
 * непроинициализированная БД: fix-отклонение спеки требует одной внятной
 * ошибки вместо сырого «no such table» на одних путях и молчаливого
 * «email не в кэше» на другом.
 */
const TABLES = [
  "sl_clients",
  "sl_spreadsheets",
  "sl_wb_sids",
  "x10_email_clients",
] as const;

/** Отказ до первого запроса, если схемы в БД нет (спека, «Отклонения»). */
export function assertInitialized(cache: CacheReader): void {
  const rows = cache.query(
    "SELECT name FROM sqlite_master WHERE type = 'table'" +
      ` AND name IN (${placeholders(TABLES.length)})`,
    ...TABLES,
  );
  if (rows.length === TABLES.length) return;
  throw new SelectorError("кэш-БД не инициализирована", { hint: "mpu init" });
}

/**
 * Кандидаты названных клиентов: по строке на каждую таблицу клиента, а у
 * клиента без таблиц — одна строка с пустыми полями таблицы. Сервер
 * строки берётся у её таблицы, у строки без таблицы — из реестра клиентов.
 */
export function clientCandidates(
  cache: CacheReader,
  clientIds: readonly number[],
): readonly Candidate[] {
  if (clientIds.length === 0) return [];
  const rows = cache.query(
    "SELECT c.client_id AS client_id, s.ss_id AS spreadsheet_id," +
      " s.title AS title," +
      " CASE WHEN s.ss_id IS NULL THEN c.server ELSE s.server END AS server" +
      " FROM sl_clients c" +
      " LEFT JOIN sl_spreadsheets s ON s.client_id = c.client_id" +
      ` WHERE c.client_id IN (${placeholders(clientIds.length)})` +
      " ORDER BY c.client_id, s.ss_id",
    ...clientIds,
  );
  return withSids(cache, rows);
}

/** Кандидаты-таблицы, чей столбец содержит значение как подстроку. */
export function spreadsheetCandidates(
  cache: CacheReader,
  // Столбец подставляется в текст запроса, но это не внешние данные:
  // union из двух литералов, других значений тип не допускает.
  column: "ss_id" | "title",
  value: string,
): readonly Candidate[] {
  const rows = cache.query(
    "SELECT client_id, ss_id AS spreadsheet_id, title, server" +
      ` FROM sl_spreadsheets WHERE ${column} LIKE '%' || ? || '%'` +
      " ORDER BY client_id, ss_id",
    value,
  );
  return withSids(cache, rows);
}

/** Клиенты, которыми владеет email; строки нет — пустой список. */
export function clientIdsOfEmail(
  cache: CacheReader,
  email: string,
): readonly number[] {
  const rows = cache.query(
    "SELECT owned_client_ids FROM x10_email_clients WHERE email = ?",
    email,
  );
  return rows.length === 0
    ? []
    : ownedClientIds(textOf(rows[0].owned_client_ids));
}

/** Клиенты по WB sid: сначала точное совпадение, затем подстрока. */
export function clientIdsOfSid(
  cache: CacheReader,
  sid: string,
): readonly number[] {
  const exact = cache.query(
    "SELECT DISTINCT client_id FROM sl_wb_sids WHERE sid = ?" +
      " ORDER BY client_id",
    sid,
  );
  const rows = exact.length > 0 ? exact : cache.query(
    "SELECT DISTINCT client_id FROM sl_wb_sids WHERE sid LIKE '%' || ? || '%'" +
      " ORDER BY client_id",
    sid,
  );
  return rows.map((row) => intOf(row.client_id, "sl_wb_sids.client_id"));
}

/** Строки выборки в кандидатов: один запрос на sid'ы всех их клиентов. */
function withSids(
  cache: CacheReader,
  rows: readonly SqlRow[],
): readonly Candidate[] {
  const sids = sidsByClient(
    cache,
    [...new Set(rows.map((row) => intOf(row.client_id, "client_id")))],
  );
  return rows.map((row) => {
    const clientId = intOf(row.client_id, "client_id");
    const server = textOf(row.server);
    return {
      clientId,
      spreadsheetId: textOf(row.spreadsheet_id),
      title: textOf(row.title),
      server,
      serverNumber: serverNumberOf(server),
      sids: sids.get(clientId) ?? [],
    };
  });
}

function sidsByClient(
  cache: CacheReader,
  clientIds: readonly number[],
): Map<number, string[]> {
  const byClient = new Map<number, string[]>();
  if (clientIds.length === 0) return byClient;
  const rows = cache.query(
    "SELECT client_id, sid FROM sl_wb_sids" +
      ` WHERE client_id IN (${placeholders(clientIds.length)})` +
      " ORDER BY sid",
    ...clientIds,
  );
  for (const row of rows) {
    const clientId = intOf(row.client_id, "sl_wb_sids.client_id");
    const sid = textRequired(row.sid, "sl_wb_sids.sid");
    const known = byClient.get(clientId);
    if (known === undefined) byClient.set(clientId, [sid]);
    else known.push(sid);
  }
  return byClient;
}

/** Список клиентов из строки кэша email→клиент: JSON-массив целых. */
function ownedClientIds(raw: string | null): readonly number[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Битая строка кэша равнозначна её отсутствию: пользователь получит
    // «email не в кэше; сначала запусти: mpu search …» — ровно ту команду,
    // которая строку перезапишет. Своего текста для этого у спеки нет.
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter((value): value is number => Number.isInteger(value))
    : [];
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/** Текст столбца; NULL и не-текст — `null`. */
function textOf(value: SqlRow[string]): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Целое столбца. Все столбцы, откуда оно читается, объявлены схемой как
 * NOT NULL INTEGER (`fixtures/platform/store/schema.sql`), поэтому иное
 * значение — испорченный файл БД, а не предвидимый ввод.
 */
function intOf(value: SqlRow[string], column: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new TypeError(`${column}: в кэш-БД не целое число`);
}

/** То же для NOT NULL TEXT: подстановка пустой строки скрыла бы порчу. */
function textRequired(value: SqlRow[string], column: string): string {
  const text = textOf(value);
  if (text === null) throw new TypeError(`${column}: в кэш-БД не текст`);
  return text;
}
