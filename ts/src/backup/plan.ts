/**
 * План бэкапа таблицы клиента (`docs/specs/backup.md`): что копируем,
 * куда и каким запросом.
 *
 * Чистые функции: и SQL, и мета-блок собираются без соединения — режим
 * `--dry` тем и ценен, что показывает ровно то, что ушло бы серверу.
 */

import { UsageError } from "../command/mod.ts";
import { type Candidate, formatCandidates } from "../selector/mod.ts";
import { localDate } from "../dates/mod.ts";

/** Суффикс даты: ровно восемь цифр, `YYYYMMDD`. */
const DATE = /^\d{8}$/;

/** Селектор, который сам по себе является client_id. */
const CLIENT_ID = /^\d+$/;

/**
 * Смещение МСК в минутах в форме `Date.getTimezoneOffset()`. Дата
 * суффикса — московская, а не машинная: имя копии читают люди, у
 * которых рабочий день по Москве, и на машине в другом поясе суффикс
 * не должен разъезжаться с их календарём.
 */
const MSK_OFFSET_MINUTES = -180;

/** Таблица-источник и её витрина. */
export interface BackupTable {
  /** Площадка: попадает в мета-блок первой строкой. */
  readonly marketplace: string;
  /** Имя таблицы в схеме клиента; оно же в имени копии. */
  readonly table: string;
}

/** Всё, что нужно знать о копии до соединения. */
export interface BackupPlan {
  readonly marketplace: string;
  readonly sourceTable: string;
  readonly dateSuffix: string;
  readonly schemaId: number;
  readonly sql: string;
}

/** Сегодняшняя дата по Москве в форме суффикса. */
export function mskDateSuffix(nowMs: number): string {
  return localDate(nowMs, MSK_OFFSET_MINUTES).replaceAll("-", "");
}

/**
 * Суффикс даты: заданный проверяется, незаданный берётся по Москве.
 * Проверка до соединения — неверная дата не стоит обращения к серверу.
 */
export function dateSuffix(raw: string | undefined, nowMs: number): string {
  if (raw === undefined) return mskDateSuffix(nowMs);
  if (!DATE.test(raw)) {
    throw new UsageError(`bad --date '${raw}', expected YYYYMMDD`);
  }
  return raw;
}

/**
 * Номер схемы: явный флаг, иначе единственный client_id кандидатов,
 * иначе сам селектор, если он — число.
 *
 * Последняя ступень нужна для сервера, которого нет в кэше: `mpu init`
 * мог не пройти, а бэкап всё равно снимают. Неоднозначность отбивается
 * со списком кандидатов — угадывать, какого клиента копировать, нельзя.
 */
export function schemaIdOf(
  explicit: number | undefined,
  selector: string,
  candidates: readonly Candidate[],
): number {
  if (explicit !== undefined) return explicit;
  const ids = new Set(
    candidates.map((candidate) => candidate.clientId).filter((id) =>
      id !== null
    ),
  );
  if (ids.size === 1) return [...ids][0];
  if (ids.size === 0 && CLIENT_ID.test(selector.trim())) {
    return Number(selector.trim());
  }
  const list = formatCandidates(candidates);
  throw new UsageError(
    `cannot derive client_id from selector '${selector}'; ` +
      "pass --schema-id explicitly",
    { details: list === "" ? undefined : list.slice(0, -1) },
  );
}

/**
 * Запрос копии. Перевод строки перед `SELECT` — часть формы: запрос
 * читают глазами в мета-блоке, и обе его половины стоят на своих
 * строках (`docs/specs/backup.md`, форма дословная).
 */
export function backupSql(
  table: BackupTable,
  schemaId: number,
  date: string,
): string {
  return `CREATE TABLE backups.${table.table}_${schemaId}_${date} AS\n` +
    `SELECT * FROM schema_${schemaId}.${table.table};`;
}

/** План целиком: имена, дата и готовый запрос. */
export function backupPlan(
  table: BackupTable,
  schemaId: number,
  date: string,
): BackupPlan {
  return {
    marketplace: table.marketplace,
    sourceTable: table.table,
    dateSuffix: date,
    schemaId,
    sql: backupSql(table, schemaId, date),
  };
}
