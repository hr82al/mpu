/**
 * План очистки локальных клиентов (`docs/specs/clean-local-clients.md`):
 * разбор keep-листа, вычисление целей и тексты SQL.
 *
 * Модуль чистый и потому проверяемый без стенда — а стенда у этой
 * команды не будет ни у кого: реальную очистку не гоняют, потому что на
 * локальном стенде живут данные, нужные другим проверкам. Значит SQL
 * обязан читаться и сверяться как текст, а не «проверяться прогоном».
 *
 * Keep-лист инверсный: перечисляют то, что оставить. Схема `shared`
 * номера клиента не имеет и в цели не попадает никогда — не потому, что
 * её отфильтровали, а потому что множество целей строится только из
 * схем вида `schema_<N>`.
 */

import { UsageError } from "../command/mod.ts";
import {
  SL0_CLIENT_TABLES,
  SL1_CLIENT_TABLES,
  SPREADSHEET_CHILDREN,
} from "../copy/rows.ts";

/** Keep-лист по умолчанию (`clean-local-clients.md`). */
export const DEFAULT_KEEP: readonly number[] = [54, 776];

/** Регулярное выражение схемы клиента; `shared` под него не подходит. */
export const CLIENT_SCHEMA = /^schema_(\d+)$/;

/**
 * Наборы таблиц — те же, что у копии клиента (`copy/rows.ts`): очистка
 * убирает ровно то, что завела копия. Второй список разъехался бы с
 * первым, и на стенде оставались бы строки, которых никто не ждёт.
 */
export {
  SL0_CLIENT_TABLES,
  SL1_CLIENT_TABLES,
  SPREADSHEET_CHILDREN,
} from "../copy/rows.ts";

/**
 * Разбор `--keep`: список client_id через запятую. Пробелы вокруг
 * токенов допустимы, пустые токены пропускаются — `--keep ""` означает
 * пустой keep-лист, то есть «снести всё локальное», и это валидный
 * вызов.
 */
export function parseKeep(raw: string | undefined): readonly number[] {
  if (raw === undefined) return DEFAULT_KEEP;
  const keep: number[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed === "") continue;
    if (!/^\d+$/.test(trimmed)) {
      throw new UsageError(
        `keep: '${trimmed}' не число (ожидается список client_id)`,
      );
    }
    keep.push(Number(trimmed));
  }
  return keep;
}

/** Номера клиентов из имён схем; всё, что не `schema_<N>`, отброшено. */
export function clientsOf(schemas: readonly string[]): readonly number[] {
  const ids: number[] = [];
  for (const name of schemas) {
    const match = CLIENT_SCHEMA.exec(name);
    if (match !== null) ids.push(Number(match[1]));
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Цели = найденные клиенты минус keep-лист. */
export function targetsOf(
  clients: readonly number[],
  keep: readonly number[],
): readonly number[] {
  return clients.filter((id) => !keep.includes(id));
}

/** Список чисел для отчёта; пусто — прочерк. */
export function listText(ids: readonly number[]): string {
  return ids.length === 0 ? "—" : `[${ids.join(", ")}]`;
}

/** Отчёт-план: что нашли, что оставляем, что удаляем. */
export function planReport(
  clients: readonly number[],
  keep: readonly number[],
  targets: readonly number[],
): string {
  return [
    `локальные клиенты sl-1: ${listText(clients)}`,
    `оставляю (keep): ${listText(keep)} + схема shared`,
    `под удаление: ${listText(targets)}`,
    // Пустая строка отделяет план от итога: голден канала показывает
    // её между блоками, и она — часть формы, а не отступ «для красоты».
    "",
    "",
  ].join("\n");
}

/** Хвост сухого прогона: что делать, чтобы удалить по-настоящему. */
export const DRY_RUN_TAIL =
  "сухой прогон — ничего не удалено. Для удаления повтори с --yes";

/** Хвост, когда удалять нечего. */
export const NOTHING_TAIL =
  "✓ нечего удалять — все локальные клиенты в keep-листе";

/** Список чисел для SQL-предиката `IN (…)`. */
function inList(ids: readonly number[]): string {
  return ids.join(", ");
}

/**
 * SQL очистки локального sl-1 одной транзакцией. `replica`-режим
 * снимает FK и триггеры, поэтому порядок таблиц значения не имеет —
 * это и есть причина, по которой он здесь включён (`copy-client.md`,
 * шаг 3, тот же приём).
 */
export function sl1Sql(targets: readonly number[]): string {
  const ids = inList(targets);
  const spreadsheets =
    `SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id IN (${ids})`;
  const lines = [
    "SET session_replication_role = replica;",
    ...SPREADSHEET_CHILDREN.map((table) =>
      `DELETE FROM public.${table} WHERE spreadsheet_id IN (${spreadsheets});`
    ),
    `DELETE FROM public.clients WHERE id IN (${ids});`,
    ...SL1_CLIENT_TABLES.map((table) =>
      `DELETE FROM public.${table} WHERE client_id IN (${ids});`
    ),
    ...targets.map((id) => `DROP SCHEMA IF EXISTS schema_${id} CASCADE;`),
  ];
  return lines.join("\n");
}

/** SQL очистки локального sl-0: клиенты и их токены. */
export function sl0Sql(targets: readonly number[]): string {
  const ids = inList(targets);
  return [
    "SET session_replication_role = replica;",
    `DELETE FROM public.clients WHERE id IN (${ids});`,
    ...SL0_CLIENT_TABLES.map((table) =>
      `DELETE FROM public.${table} WHERE client_id IN (${ids});`
    ),
  ].join("\n");
}

/** Email-сигнатура входа, заведённого копией клиента. */
export function localEmail(clientId: number): string {
  return `client_${clientId}@local.host`;
}
