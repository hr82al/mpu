/**
 * Кэш листов и метаданных (`platform/webapp-http.md`, «Кэш листов»,
 * «Метаданные», «Housekeeping»).
 *
 * Единица кэширования — лист целиком: запрошенный span вырезается из
 * него пост-фактум. Частичных записей не бывает — иначе следующий
 * вызов не знал бы, чего в записи не хватает.
 */

import type { CacheDb, SqlRow } from "../command/mod.ts";

/** Лист в кэше: два слоя и фактические границы. */
export interface TabPayload {
  readonly values: readonly (readonly unknown[])[];
  readonly formulas: readonly (readonly unknown[])[];
  readonly dims: { readonly rows: number; readonly cols: number };
}

/** Метаданные листа из `spreadsheets/get`. */
export interface TabInfo {
  readonly title: string;
  readonly sheet_id: number;
  readonly rows: number;
  readonly cols: number;
  readonly index: number;
}

/** Настройки кэша (`platform/config.md`, int-ключи). */
export interface CacheSettings {
  readonly tabTtlSeconds: number;
  readonly maxTabBytes: number;
  readonly maxTotalMb: number;
}

/** TTL кэша метаданных фиксирован и конфигом не меняется. */
export const INFO_TTL_SECONDS = 7200;

/** Ключ метаданных в общей таблице `cache`. */
export function infoKey(ssId: string): string {
  return `sheet:info:${ssId}`;
}

/**
 * Убирает протухшие листы и, если общий объём выше предела, старейшие
 * записи. Отсутствие таблиц кэша — не ошибка: у свежей БД чистить
 * нечего.
 */
export function housekeeping(
  db: CacheDb,
  settings: CacheSettings,
  nowSeconds: number,
): void {
  try {
    db.execute(
      "DELETE FROM sheet_tabs WHERE fetched_at < ?",
      nowSeconds - settings.tabTtlSeconds,
    );
    const limit = settings.maxTotalMb * 1024 * 1024;
    let total = totalBytes(db);
    if (total <= limit) return;
    for (const row of oldestFirst(db)) {
      db.execute(
        "DELETE FROM sheet_tabs WHERE ss_id = ? AND tab_name = ?",
        String(row.ss_id),
        String(row.tab_name),
      );
      total -= Number(row.size_bytes);
      if (total <= limit) return;
    }
  } catch {
    // Таблиц кэша ещё нет: bootstrap создаёт их при первом `mpu init`,
    // а команда обязана работать и до него (атом, «Housekeeping»).
  }
}

function totalBytes(db: CacheDb): number {
  const rows = db.query(
    "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM sheet_tabs",
  );
  return Number(rows[0]?.total ?? 0);
}

function oldestFirst(db: CacheDb): readonly SqlRow[] {
  return db.query(
    "SELECT ss_id, tab_name, size_bytes FROM sheet_tabs ORDER BY fetched_at",
  );
}

/**
 * Лист из кэша; записи нет или она протухла — `undefined`. TTL
 * проверяется на чтении, поэтому изменение настройки действует и на
 * уже лежащие записи.
 */
export async function readTab(
  db: CacheDb,
  ssId: string,
  tab: string,
  settings: CacheSettings,
  nowSeconds: number,
): Promise<TabPayload | undefined> {
  try {
    const rows = db.query(
      "SELECT payload, fetched_at FROM sheet_tabs" +
        " WHERE ss_id = ? AND tab_name = ?",
      ssId,
      tab,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    if (nowSeconds - Number(row.fetched_at) > settings.tabTtlSeconds) {
      return undefined;
    }
    const payload = row.payload;
    if (!(payload instanceof Uint8Array)) return undefined;
    return JSON.parse(await gunzip(payload)) as TabPayload;
  } catch {
    // Битая или нечитаемая запись равнозначна её отсутствию: кэш —
    // ускорение, и уронить им вызов нельзя (см. `writeTab`).
    return undefined;
  }
}

/** Кладёт лист в кэш целиком; запись перетирается по ключу. */
export async function writeTab(
  db: CacheDb,
  ssId: string,
  tab: string,
  payload: TabPayload,
  nowSeconds: number,
): Promise<void> {
  const bytes = await gzip(JSON.stringify(payload));
  try {
    db.execute(
      "INSERT INTO sheet_tabs (ss_id, tab_name, payload, size_bytes," +
        " fetched_at) VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(ss_id, tab_name) DO UPDATE SET payload = excluded.payload," +
        " size_bytes = excluded.size_bytes, fetched_at = excluded.fetched_at",
      ssId,
      tab,
      bytes,
      bytes.length,
      nowSeconds,
    );
  } catch {
    // Запись кэша — ускорение, а не результат вызова: БД без таблиц
    // не должна ронять чтение таблицы.
  }
}

/** Метаданные из кэша; протухшая запись равнозначна отсутствующей. */
export function readInfo(
  db: CacheDb,
  ssId: string,
  nowSeconds: number,
): readonly TabInfo[] | undefined {
  let rows: readonly SqlRow[];
  try {
    rows = db.query(
      "SELECT value FROM cache WHERE key = ? AND expires_at > ?",
      infoKey(ssId),
      nowSeconds,
    );
  } catch {
    return undefined;
  }
  const value = rows[0]?.value;
  if (typeof value !== "string") return undefined;
  return JSON.parse(value) as readonly TabInfo[];
}

/** Кладёт метаданные в общий кэш с фиксированным TTL. */
export function writeInfo(
  db: CacheDb,
  ssId: string,
  tabs: readonly TabInfo[],
  nowSeconds: number,
): void {
  try {
    db.execute(
      "INSERT INTO cache (key, value, created_at, expires_at)" +
        " VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET" +
        " value = excluded.value, created_at = excluded.created_at," +
        " expires_at = excluded.expires_at",
      infoKey(ssId),
      JSON.stringify(tabs),
      nowSeconds,
      nowSeconds + INFO_TTL_SECONDS,
    );
  } catch {
    // См. `writeTab`: кэш метаданных тоже только ускоряет.
  }
}

/** Сжатие payload'а: у листа на тысячу строк оно кратно экономит место. */
async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await new Response(stream).text();
}
