/**
 * Перенос public- и токен-строк клиента (`copy-client.md`, шаги 3–4):
 * DELETE по фильтру на приёмнике плюс вставка снятого с источника.
 *
 * Замена, а не слияние: повторный прогон обязан давать эквивалентное
 * состояние без дублей (инвариант спеки), а слияние по ключам этого не
 * даёт — у части таблиц ключа нет вовсе.
 *
 * Весь посев уходит приёмнику ОДНИМ текстом и потому одной
 * транзакцией. Разбив его на вызовы, мы получили бы commit после
 * каждого DELETE: упавшая на середине вставка оставила бы стенд в
 * состоянии хуже, чем до запуска, — строки снесены и не восстановлены
 * (спека, шаг 3: «Один commit на весь посев»).
 */

import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";

/** Таблицы sl-1, где строки клиента лежат по `client_id`. */
export const SL1_CLIENT_TABLES: readonly string[] = [
  "wb_tokens",
  "clients_wb_cabinets",
  "clients_modules",
  "data_loader_info",
  "data_processor_info",
  "ozon_loader_info",
  "ozon_loader_info_v2",
  "wb_loader_info",
  "wb_loader_info_v2",
  "wb_loader_nm_ids_data",
  "spreadsheets",
];

/** Дети `spreadsheets`: переносятся по множеству spreadsheet_id. */
export const SPREADSHEET_CHILDREN: readonly string[] = [
  "spreadsheets_sheets",
  "spreadsheets_sheets_values",
  "spreadsheets_datasets",
  "spreadsheets_datasets_values",
  "spreadsheets_loader_data",
];

/** Таблицы sl-0: клиенты и их токены. */
export const SL0_CLIENT_TABLES: readonly string[] = [
  "wb_tokens",
  "clients_wb_cabinets",
];

/** Сколько строк перенесено в одну таблицу. */
export interface TableCount {
  readonly table: string;
  readonly rows: number;
}

/** Строковый литерал SQL: единственная кавычка удваивается. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Значение как литерал SQL.
 *
 * Драйвер отдаёт большинство типов уже текстом (даты, json, numeric —
 * `TEXT_OIDS` в `sql/pg.ts`), поэтому текст и уходит текстом. Особые
 * случаи здесь ровно те, где «просто подставить» означало бы испортить
 * данные молча: байты, массивы и нечисловые числа.
 */
export function literalOf(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") {
    // `Infinity`/`NaN` голым текстом — синтаксическая ошибка сервера;
    // у PostgreSQL для них свои литералы, и они строковые.
    if (Number.isFinite(value)) return String(value);
    return `'${
      value === Infinity
        ? "Infinity"
        : value === -Infinity
        ? "-Infinity"
        : "NaN"
    }'`;
  }
  if (typeof value === "string") return quoted(value);
  if (value instanceof Date) return quoted(value.toISOString());
  if (value instanceof Uint8Array) {
    // bytea: hex-форма. JSON.stringify превратил бы буфер в
    // `{"type":"Buffer",…}` — в bytea это не влезет, а в text-колонку
    // влезет и молча испортит содержимое.
    const hex = [...value].map((byte) => byte.toString(16).padStart(2, "0"));
    return `'\\x${hex.join("")}'`;
  }
  if (Array.isArray(value)) {
    // Массив PostgreSQL — `{…}`, а не `[…]`: JSON-форма дала бы
    // `malformed array literal`.
    const items = value.map((item) =>
      item === null ? "NULL" : `"${String(item).replaceAll('"', '\\"')}"`
    );
    return quoted(`{${items.join(",")}}`);
  }
  return quoted(JSON.stringify(value));
}

/** Строки таблицы источника как INSERT приёмника. */
export function insertsOf(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  if (rows.length === 0) return "";
  const names = columns.map((name) => `"${name}"`).join(", ");
  const values = rows
    .map((row) => `(${row.map(literalOf).join(", ")})`)
    .join(",\n  ");
  return `INSERT INTO public.${table} (${names}) VALUES\n  ${values};`;
}

/** Набор строк результата; иначе пусто. */
function rowsOf(
  outcome: SqlOutcome,
): { columns: readonly string[]; rows: readonly (readonly unknown[])[] } {
  return outcome.kind === "rows"
    ? { columns: outcome.columns, rows: outcome.rows }
    : { columns: [], rows: [] };
}

/** Первая колонка всех строк как строки. */
export function firstColumn(outcome: SqlOutcome): readonly string[] {
  return rowsOf(outcome).rows
    .map((row) => row[0])
    .filter((value) => value !== null && value !== undefined)
    .map(String);
}

/** Готовые операторы одной таблицы и число перенесённых строк. */
export interface TableStatements {
  readonly count: TableCount;
  readonly statements: readonly string[];
}

/**
 * Читает таблицу с источника и собирает операторы приёмника: сначала
 * DELETE по фильтру приёмника, затем вставка прочитанного.
 *
 * `deleteWhere` отдельно от `selectWhere` не для гибкости: у детей
 * `spreadsheets` удалять надо по ОБЪЕДИНЕНИЮ множеств источника и
 * приёмника, иначе строки таблицы, удалённой на проде, останутся на
 * стенде висеть сиротами (спека, шаг 3).
 */
export async function tableStatements(
  source: SqlSession,
  table: string,
  selectWhere: string,
  deleteWhere: string = selectWhere,
): Promise<TableStatements> {
  const selected = rowsOf(
    await source.query(`SELECT * FROM public.${table} WHERE ${selectWhere}`),
  );
  const statements = [`DELETE FROM public.${table} WHERE ${deleteWhere};`];
  const insert = insertsOf(table, selected.columns, selected.rows);
  if (insert !== "") statements.push(insert);
  return {
    count: { table, rows: selected.rows.length },
    statements,
  };
}

/** Фильтр строк клиента. */
export function clientWhere(clientId: number): string {
  return `client_id = ${clientId}`;
}

/**
 * Фильтр по множеству spreadsheet_id. Идентификатор — строка (у Google
 * это `1BxiMVs0XRA5…`), поэтому значения квотируются; приведение к
 * числу выбросило бы их все и дало тихую недокопию.
 *
 * Пустое множество даёт предикат `false`: `IN ()` — синтаксическая
 * ошибка, а «таблиц у клиента нет» — штатный случай.
 */
export function spreadsheetWhere(ids: readonly string[]): string {
  return ids.length === 0
    ? "false"
    : `spreadsheet_id IN (${ids.map(quoted).join(", ")})`;
}

/** Идентификаторы таблиц клиента на стороне, где выполняется запрос. */
export async function spreadsheetIds(
  session: SqlSession,
  clientId: number,
): Promise<readonly string[]> {
  return firstColumn(
    await session.query(
      `SELECT spreadsheet_id FROM public.spreadsheets ` +
        `WHERE client_id = ${clientId}`,
    ),
  );
}
