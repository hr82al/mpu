/**
 * Резолв цели-spreadsheet (`platform/webapp-http.md`, «Резолв цели»):
 * флаг → env → конфиг, затем разбор победившего значения.
 *
 * Источники не смешиваются: первый непустой побеждает целиком, и
 * разбирается именно он. Иначе «ID из флага, но алиас из env» дал бы
 * цель, которую никто не называл.
 */

import { UsageError } from "../command/mod.ts";

/**
 * Откуда пришло значение цели. Переменных окружения среди источников
 * нет вовсе — решение пользователя 2026-08-27: «только явно через
 * параметры» (`sheet.md`, «Открытые вопросы»).
 */
export type TargetSource = "flag" | "config";

/** Чем оказалось значение. */
export type TargetKind = "url" | "id" | "alias" | "client_id" | "title_fuzzy";

/** Разрешённая цель — ровно то, что печатает `mpu sheet resolve`. */
export interface Target {
  readonly ss_id: string;
  readonly source: TargetSource;
  readonly kind: TargetKind;
  readonly original_input: string;
}

/** Строка таблицы `sl_spreadsheets`, нужная резолву. */
export interface SpreadsheetRow {
  readonly ssId: string;
  readonly title: string;
}

/** Чтение кэш-БД глазами резолва: алиасы и таблицы клиентов. */
export interface TargetSources {
  /** `ss_id` алиаса; алиаса нет — `undefined`. */
  readonly aliasOf: (name: string) => string | undefined;
  /** Активные таблицы клиента по его номеру. */
  readonly byClientId: (clientId: number) => readonly SpreadsheetRow[];
  /** Активные таблицы, чей заголовок содержит подстроку. */
  readonly byTitle: (substring: string) => readonly SpreadsheetRow[];
}

/** Значения источников цели по приоритету. */
export interface TargetInput {
  readonly flag?: string;
  readonly config?: string;
}

const URL_PREFIX = "https://docs.google.com/spreadsheets/d/";
const ID_CHARS = /^[A-Za-z0-9_-]{20,}$/;
const DIGITS = /^\d+$/;

/** Сколько кандидатов показывается в отказе, прежде чем свернуться. */
const SHOWN_CANDIDATES = 10;

/**
 * Совет называет только работающие пути: флаг и ключ конфигурации.
 * Прежняя формулировка советовала `export MPU_SS=<id>`, то есть
 * обещала источник, которого у команды нет (`sheet.md`, отклонение
 * `fix`).
 */
const NOT_SET = "Spreadsheet не указан. Используй --spreadsheet/-s или " +
  "установи `sheet.default`: mpu config sheet.default <id-or-name>.";

/** Цель по источникам; ни один не задан — ошибка ввода. */
export function resolveTarget(
  input: TargetInput,
  sources: TargetSources,
): Target {
  const chosen = firstFilled(input);
  if (chosen === undefined) throw new UsageError(NOT_SET);
  const [source, value] = chosen;
  const kind = parseValue(value, sources);
  return { ss_id: kind.ssId, source, kind: kind.kind, original_input: value };
}

/** Первый непустой источник по приоритету флаг → конфиг. */
function firstFilled(
  input: TargetInput,
): readonly [TargetSource, string] | undefined {
  const pairs: readonly (readonly [TargetSource, string | undefined])[] = [
    ["flag", input.flag],
    ["config", input.config],
  ];
  for (const [source, value] of pairs) {
    if (value !== undefined && value.trim() !== "") {
      return [source, value.trim()];
    }
  }
  return undefined;
}

/** Разбор значения по порядку до первого совпадения. */
function parseValue(
  value: string,
  sources: TargetSources,
): { readonly ssId: string; readonly kind: TargetKind } {
  const url = value.indexOf(URL_PREFIX);
  if (url !== -1) {
    const tail = value.slice(url + URL_PREFIX.length);
    const id = /^[A-Za-z0-9_-]+/.exec(tail)?.[0] ?? "";
    if (id !== "") return { ssId: id, kind: "url" };
  }
  if (ID_CHARS.test(value)) return { ssId: value, kind: "id" };
  const alias = sources.aliasOf(value);
  if (alias !== undefined) return { ssId: alias, kind: "alias" };
  if (DIGITS.test(value)) {
    const rows = sources.byClientId(Number(value));
    if (rows.length === 0) {
      throw new UsageError(
        `client_id=${value} не найден в sl_spreadsheets. ` +
          "Запусти `mpu sheet sync` чтобы обновить кэш.",
      );
    }
    return { ssId: onlyRow(rows, value).ssId, kind: "client_id" };
  }
  const rows = sources.byTitle(value);
  if (rows.length === 0) {
    throw new UsageError(
      `Spreadsheet '${value}' не найден ни как ID/URL/alias/client_id/` +
        "title. Запусти `mpu sheet sync` чтобы обновить кэш.",
    );
  }
  return { ssId: onlyRow(rows, value).ssId, kind: "title_fuzzy" };
}

/**
 * Единственная строка выдачи; несколько — многострочный отказ со
 * списком: выбрать за человека, какую из его таблиц открыть, нельзя.
 */
function onlyRow(
  rows: readonly SpreadsheetRow[],
  value: string,
): SpreadsheetRow {
  if (rows.length === 1) return rows[0];
  const shown = rows.slice(0, SHOWN_CANDIDATES)
    .map((row) => `  ${row.ssId}  ${row.title}`);
  const rest = rows.length - shown.length;
  const tail = rest > 0 ? [`  …(+${rest} more)`] : [];
  throw new UsageError(
    [
      `Несколько spreadsheet'ов матчат '${value}':`,
      ...shown,
      ...tail,
      "Уточни через --spreadsheet/-s или используй точный ID/alias.",
    ].join("\n"),
  );
}
