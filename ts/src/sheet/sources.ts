/**
 * Общие части трёх подкоманд `mpu sheet` (`docs/specs/sheet.md`):
 * резолв цели по кэш-БД и сбор диапазонов из аргументов и файла.
 */

import {
  type CacheDb,
  type CommandIo,
  NotFoundIoError,
  readTextStdin,
  UsageError,
} from "../command/mod.ts";
import { configValue } from "./settings.ts";
import { resolveTarget, type Target, type TargetSources } from "./target.ts";

/** Срез порта: кэш-БД, env-файл, локальные настройки и stdin. */
export type SheetIo = Pick<
  CommandIo,
  | "envFile"
  | "openCacheDb"
  | "readConfigStore"
  | "readTextFile"
  | "readStdin"
  | "note"
>;

/** Источники резолва поверх открытой кэш-БД. */
export function cacheSources(db: CacheDb): TargetSources {
  return {
    aliasOf: (name) => {
      const rows = query(
        db,
        "SELECT ss_id FROM sheet_aliases WHERE name = ?",
        name,
      );
      const value = rows[0]?.ss_id;
      return typeof value === "string" ? value : undefined;
    },
    byClientId: (clientId) =>
      query(
        db,
        "SELECT ss_id, title FROM sl_spreadsheets WHERE client_id = ?" +
          " AND is_active = 1 ORDER BY title",
        clientId,
      ).map(rowOf),
    // Регистр снимается в TS, а не в SQL: `lower()` SQLite работает
    // только с ASCII, и «ОЗОН» не нашёл бы «Отчёт Ozon»… точнее, не
    // нашёл бы «озон». Таблиц у клиента сотни, не миллионы.
    byTitle: (substring) => {
      const needle = substring.toLowerCase();
      return query(
        db,
        "SELECT ss_id, title FROM sl_spreadsheets WHERE is_active = 1" +
          " ORDER BY title",
      )
        .map(rowOf)
        .filter((row) => row.title.toLowerCase().includes(needle));
    },
  };
}

/** Запрос к кэш-БД; таблиц ещё нет — пустая выдача, а не отказ. */
function query(
  db: CacheDb,
  sql: string,
  ...params: readonly (string | number)[]
): readonly Record<string, unknown>[] {
  try {
    return db.query(sql, ...params) as readonly Record<string, unknown>[];
  } catch {
    // Свежая БД без bootstrap: резолв по алиасу и заголовку тогда
    // просто ничего не находит (атом, «Граничные случаи»).
    return [];
  }
}

function rowOf(row: Record<string, unknown>) {
  return { ssId: String(row.ss_id), title: String(row.title ?? "") };
}

/**
 * Цель вызова: флаг `-s`, иначе конфиг-ключ `sheet.default`.
 * Переменных окружения среди источников нет вовсе — ни из процесса, ни
 * из env-файла (`sheet.md`, «Открытые вопросы»).
 */
export async function targetOf(
  io: SheetIo,
  db: CacheDb,
  flag: string | undefined,
): Promise<Target> {
  return resolveTarget(
    { flag, config: await configValue(io, "sheet.default") },
    cacheSources(db),
  );
}

/**
 * Диапазоны вызова: аргументы плюс строки `--from`. Источники
 * складываются, а не заменяют друг друга: файл со списком листов и
 * пара диапазонов руками — обычный вызов.
 */
export async function rangeStrings(
  io: SheetIo,
  args: readonly string[],
  from: string | undefined,
): Promise<readonly string[]> {
  if (from === undefined) return args;
  const text = from === "-"
    ? await readTextStdin(io)
    : await fileText(io, from);
  const lines = text.split("\n")
    .map((line) => line.trim())
    // Пустые строки и комментарии пропускаются: список диапазонов
    // ведут руками, и в нём остаются пометки.
    .filter((line) => line !== "" && !line.startsWith("#"));
  return [...args, ...lines];
}

/** Текст файла; отсутствие — ошибка ввода, а не трейсбек (отклонение). */
async function fileText(io: SheetIo, path: string): Promise<string> {
  try {
    return await io.readTextFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new UsageError(`файл '${path}' не найден`, { cause: err });
    }
    throw err;
  }
}
