/**
 * Чтение локального кэша командой `logs` (`docs/specs/logs.md`,
 * «Конфигурация»): хосты и сервисы прогрева Loki и Portainer-цель
 * сервера. Только SELECT — команда не пишет в кэш-БД ничего.
 *
 * Отсутствующая таблица здесь не ошибка, а пустой кэш: до первого
 * `mpu init` схемы в БД нет вовсе, а сообщать об этом должна команда
 * своим текстом («запусти `mpu init`»), а не сырое «no such table».
 */

import type { CacheDb, CommandIo, SqlParam, SqlRow } from "../command/mod.ts";

/** Адрес Docker API сервера: environment Portainer и его база. */
export interface PortainerTarget {
  readonly baseUrl: string;
  readonly endpointId: number;
}

/** Кэш стенда глазами команды: только чтение. */
export interface LogsCache {
  /** Хосты прогрева Loki по возрастанию. */
  readonly hosts: () => readonly string[];
  /** Сервисы хоста по возрастанию; значение хоста берётся литерально. */
  readonly services: (host: string) => readonly string[];
  /** Есть ли такой сервис хоть на одном хосте. */
  readonly hasService: (name: string) => boolean;
  /** Portainer-цель сервера; строки в кэше нет — `undefined`. */
  readonly portainerTarget: (
    serverNumber: number,
  ) => PortainerTarget | undefined;
  /** Сырой запрос: его просит резолв селектора (`platform/selector.md`). */
  readonly query: (sql: string, ...params: SqlParam[]) => readonly SqlRow[];
}

/**
 * Кэш поверх локальной БД. Файл открывается лениво, первым же
 * запросом: путям, которым кэш не нужен (прямой хост, разбор
 * аргументов), незачем платить открытием, а `ls`-режимам — наоборот.
 * Закрывается через `using`/`Symbol.dispose` вызывающим.
 */
export function openLogsCache(io: CommandIo): LogsCache & Disposable {
  let db: CacheDb | undefined;
  const open = () => (db ??= io.openCacheDb());
  const rows = (
    table: string,
    sql: string,
    ...params: SqlParam[]
  ): readonly SqlRow[] => {
    const opened = open();
    return hasTable(opened, table) ? opened.query(sql, ...params) : [];
  };

  return {
    hosts: () =>
      column(rows("loki_hosts", "SELECT host FROM loki_hosts ORDER BY host")),
    services: (host) =>
      column(rows(
        "loki_services_by_host",
        "SELECT service FROM loki_services_by_host" +
          " WHERE host = ? ORDER BY service",
        host,
      )),
    hasService: (name) =>
      rows(
        "loki_services_by_host",
        "SELECT service FROM loki_services_by_host WHERE service = ? LIMIT 1",
        name,
      ).length > 0,
    portainerTarget: (serverNumber) => {
      const [row] = rows(
        "portainer_containers",
        "SELECT portainer_url, endpoint_id FROM portainer_containers" +
          " WHERE server_number = ? LIMIT 1",
        serverNumber,
      );
      if (row === undefined) return undefined;
      return {
        baseUrl: String(row.portainer_url),
        endpointId: Number(row.endpoint_id),
      };
    },
    query: (sql, ...params) => open().query(sql, ...params),
    [Symbol.dispose]: () => db?.[Symbol.dispose](),
  };
}

/** Есть ли таблица в схеме: её отсутствие — пустой кэш, а не отказ. */
function hasTable(db: CacheDb, name: string): boolean {
  return db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    name,
  ).length > 0;
}

/** Первый столбец выборки строками. */
function column(rows: readonly SqlRow[]): readonly string[] {
  return rows.map((row) => String(Object.values(row)[0]));
}
