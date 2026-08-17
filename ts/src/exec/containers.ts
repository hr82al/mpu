/**
 * Чтения таблицы контейнеров кэш-БД (`platform/exec-transport.md`, «Кэш
 * контейнеров»). Транспорту нужны три ответа: где искать сервер N, где
 * искать контейнер по точному имени и какие имена подходят под подстроку
 * fan-out'а. Наполняет таблицу `mpu init`; здесь только чтение.
 *
 * Неинициализированная кэш-БД (нет файла, нет таблицы) — пустой
 * результат: подсказку «запусти `mpu init`» даёт команда, у которой для
 * этого есть свой текст (спека, «Кэш контейнеров»).
 */

import type { SqlParam, SqlRow } from "../command/mod.ts";
import type { CacheReader } from "../selector/mod.ts";

/** Таблица кэша, которую читает транспорт (`platform/store.md`). */
const TABLE = "portainer_containers";

/** Где живёт Docker API контейнера: база Portainer и её endpoint. */
export interface PortainerLocation {
  readonly portainerUrl: string;
  readonly endpointId: number;
}

/** Строка кэша про контейнер с точным именем; имена — для сообщения о неоднозначности. */
export interface ContainerLocation extends PortainerLocation {
  readonly endpointName: string;
  readonly containerName: string;
}

/**
 * Portainer-таргет сервера N: строка кэша с этим `server_number`. Нет
 * строки — `null`, и вызывающий пробует env-fallback (`target.ts`).
 */
export function serverLocation(
  cache: CacheReader,
  serverNumber: number,
): PortainerLocation | null {
  const rows = read(
    cache,
    "SELECT portainer_url, endpoint_id FROM portainer_containers" +
      " WHERE server_number = ? ORDER BY portainer_url, endpoint_id LIMIT 1",
    serverNumber,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    portainerUrl: text(row.portainer_url, "portainer_url"),
    endpointId: int(row.endpoint_id, "endpoint_id"),
  };
}

/**
 * Контейнеры с точным именем. Реплики сервиса на одном endpoint'е
 * схлопывает DISTINCT; больше одной строки — контейнер с этим именем
 * живёт на разных endpoint'ах, и это честная неоднозначность (спека).
 */
export function containerLocations(
  cache: CacheReader,
  name: string,
): readonly ContainerLocation[] {
  const rows = read(
    cache,
    "SELECT DISTINCT portainer_url, endpoint_id, endpoint_name," +
      " container_name FROM portainer_containers WHERE container_name = ?",
    name,
  );
  return rows.map((row) => ({
    portainerUrl: text(row.portainer_url, "portainer_url"),
    endpointId: int(row.endpoint_id, "endpoint_id"),
    endpointName: nullableText(row.endpoint_name),
    containerName: text(row.container_name, "container_name"),
  }));
}

/** Имена контейнеров, содержащие подстроку, по возрастанию (fan-out). */
export function containerNamesLike(
  cache: CacheReader,
  filter: string,
): readonly string[] {
  const rows = read(
    cache,
    "SELECT DISTINCT container_name FROM portainer_containers" +
      " WHERE container_name LIKE ? ORDER BY container_name",
    `%${filter}%`,
  );
  return rows.map((row) => text(row.container_name, "container_name"));
}

/**
 * Номера инстанс-серверов кэша по возрастанию. Ноль и NULL не в счёт:
 * fan-out целится в однотипные инстанс-приложения, а main-сервер
 * (`sl-0`) в него не входит (`specs/run-js.md`, отклонение `preserve`).
 */
export function instanceServerNumbers(cache: CacheReader): readonly number[] {
  const rows = read(
    cache,
    "SELECT DISTINCT server_number FROM portainer_containers" +
      " WHERE server_number IS NOT NULL AND server_number > 0" +
      " ORDER BY server_number",
  );
  return rows.map((row) => int(row.server_number, "server_number"));
}

/**
 * Запрос к таблице контейнеров. Её отсутствие (кэш-БД не
 * инициализирована) — пустой ответ, как велит спека; прочие ошибки
 * запроса — не «пусто», а поломка, и уходят наверх: иначе опечатка в SQL
 * выглядела бы как ненастроенный сервер.
 */
function read(
  cache: CacheReader,
  sql: string,
  ...params: SqlParam[]
): readonly SqlRow[] {
  if (!hasTable(cache)) return [];
  return cache.query(sql, ...params);
}

/** Есть ли таблица в схеме (приём `../logs/cache.ts`). */
function hasTable(cache: CacheReader): boolean {
  try {
    return cache.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      TABLE,
    ).length > 0;
  } catch {
    // Файла БД нет вовсе либо он не открывается: для чтений транспорта
    // это тот же пустой кэш (спека, «Кэш контейнеров»).
    return false;
  }
}

/** Текст столбца NOT NULL; иное значение — испорченный файл БД. */
function text(value: SqlRow[string], column: string): string {
  if (typeof value === "string") return value;
  throw new TypeError(`${column}: в кэш-БД не текст`);
}

/** Текст столбца, где схема допускает NULL: он даёт пустую строку. */
function nullableText(value: SqlRow[string]): string {
  return typeof value === "string" ? value : "";
}

/** Целое столбца; иное значение — испорченный файл БД, а не предвидимый ввод. */
function int(value: SqlRow[string], column: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  throw new TypeError(`${column}: в кэш-БД не целое число`);
}
