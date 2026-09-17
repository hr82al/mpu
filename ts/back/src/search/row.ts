/**
 * Строка результата поиска (`docs/specs/search.md`, «Ввод/вывод»): ровно
 * восемь ключей в объявленном порядке, отсутствующее значение — `null`.
 *
 * Порядок ключей — часть наблюдаемого вывода: он попадает в JSON как
 * объявлен здесь, и голдены канала сверяются побайтово. Поэтому строка
 * собирается в одном месте, а не литералами по ветвям команды.
 */

import type { Candidate } from "../selector/mod.ts";

/** Адреса серверов из env-файла глазами сборки строки. */
export interface AddressLookup {
  readonly get: (name: string) => string | undefined;
}

/** Строка вывода: восемь ключей, `sids` — всегда массив. */
export interface SearchRow {
  readonly client_id: number | null;
  readonly spreadsheet_id: string | null;
  readonly title: string | null;
  readonly server: string | null;
  readonly server_number: number | null;
  readonly sl_ip: string | null;
  readonly pg_ip: string | null;
  readonly sids: readonly string[];
}

/** Поля, по которым команда умеет печатать проекцию (по одному за вызов). */
export const PROJECTIONS = [
  "client-id",
  "spreadsheet-id",
  "title",
  "server",
  "server-number",
  "sl-ip",
  "pg-ip",
  "sids",
] as const;

export type Projection = typeof PROJECTIONS[number];

/** Строки результата из кандидатов резолва; адреса — из env-файла. */
export function rowsOf(
  candidates: readonly Candidate[],
  env: AddressLookup,
): readonly SearchRow[] {
  return candidates.map((candidate) => ({
    client_id: candidate.clientId,
    spreadsheet_id: candidate.spreadsheetId,
    title: candidate.title,
    server: candidate.server,
    server_number: candidate.serverNumber,
    sl_ip: address(env, "sl", candidate.serverNumber),
    pg_ip: address(env, "pg", candidate.serverNumber),
    sids: candidate.sids,
  }));
}

/** Значение проекции строки: голое значение поля, `null` — пустая строка. */
export function projectionOf(row: SearchRow, projection: Projection): string {
  switch (projection) {
    case "client-id":
      return text(row.client_id);
    case "spreadsheet-id":
      return text(row.spreadsheet_id);
    case "title":
      return text(row.title);
    case "server":
      return text(row.server);
    case "server-number":
      return text(row.server_number);
    case "sl-ip":
      return text(row.sl_ip);
    case "pg-ip":
      return text(row.pg_ip);
    case "sids":
      // Через запятую и без пробела: значение годится для подстановки в
      // следующую команду, а не только для чтения глазами.
      return row.sids.join(",");
  }
}

/**
 * Адрес сервера N из env-файла (`sl_<N>`, `pg_<N>`). Номера нет — нет и
 * адреса; пустое значение ключа равнозначно отсутствию
 * (`platform/env-file.md`).
 */
function address(
  env: AddressLookup,
  prefix: "sl" | "pg",
  serverNumber: number | null,
): string | null {
  if (serverNumber === null) return null;
  const raw = env.get(`${prefix}_${serverNumber}`);
  return raw === undefined || raw === "" ? null : raw;
}

function text(value: string | number | null): string {
  return value === null ? "" : String(value);
}
