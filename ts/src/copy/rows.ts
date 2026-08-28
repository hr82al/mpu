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
import type { SqlSession, Statement } from "../sql/session.ts";

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

/**
 * Типы json и jsonb. Драйвер разбирает их **сам**: в списке типов,
 * читаемых текстом (`TEXT_OIDS` в `sql/pg.ts`), только дата и время, —
 * поэтому значение такой колонки приходит готовым значением JS,
 * объектом или массивом.
 *
 * Отсюда и вся эта функция: массив из `json` и массив из `text[]`
 * выглядят как один и тот же JS-массив, и по значению их не различить.
 * Различает их только тип колонки, который сервер сообщает вместе с
 * именем (`SqlOutcome.oids`).
 */
const JSON_OIDS: ReadonlySet<number> = new Set([114, 3802]);

/**
 * Массивов json (`json[]`, `jsonb[]` — OID 199 и 3807) здесь нет
 * намеренно: их правильная форма — литерал массива, элементы которого
 * сами тексты JSON, и `JSON.stringify` всего значения дал бы JSON-массив,
 * который в `jsonb[]` не годится. Такой колонки среди переносимых таблиц
 * не встречалось; появится — это отдельная ветка, а не строчка в списке.
 */

/**
 * Значение для параметра запроса. Почти всегда — оно само: приведение
 * делает сервер по типу целевой колонки, и это единственный способ,
 * который не требует от нас знать тип.
 *
 * Исключение одно — json и jsonb: их драйвер уже разобрал в значение
 * JS, а обратно сериализует по типу значения, и массив ушёл бы
 * литералом массива PostgreSQL (`{"a","b"}`), который в json не
 * годится: `invalid input syntax for type json`. Поэтому такое
 * значение возвращается текстом JSON — тем, чем оно и было в колонке.
 */
export function paramOf(value: unknown, oid: number): unknown {
  if (value === null || value === undefined) return null;
  if (!JSON_OIDS.has(oid)) return value;
  // Строкой оно приходит, если тип всё-таки читался текстом; тогда это
  // уже готовый JSON, и второй `JSON.stringify` завернул бы его в
  // строковый литерал.
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Предел числа параметров одного запроса у протокола PostgreSQL. Строк
 * в таблице бывает больше, чем влезает, поэтому вставка режется на
 * куски: превышение сервер отвергает целиком.
 */
const MAX_PARAMS = 65_535;

/**
 * Строки источника как параметрические INSERT приёмника. Значения не
 * подставляются в текст: сервер приводит их сам по типу колонки, а
 * текст запроса перестаёт зависеть от содержимого данных — кавычка,
 * обратный слэш и перевод строки в значении больше ничего не значат.
 */
export function insertsOf(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  oids: readonly number[] = [],
): readonly Statement[] {
  if (rows.length === 0 || columns.length === 0) return [];
  const names = columns.map((column) => `"${column}"`).join(", ");
  const perRow = columns.length;
  const chunk = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  const out: Statement[] = [];
  for (let at = 0; at < rows.length; at += chunk) {
    const slice = rows.slice(at, at + chunk);
    const params: unknown[] = [];
    const tuples = slice.map((row) => {
      const places = row.map((value, column) => {
        params.push(paramOf(value, oids[column] ?? 0));
        return `$${params.length}`;
      });
      return `(${places.join(", ")})`;
    });
    out.push({
      sql: `INSERT INTO public.${table} (${names}) VALUES\n  ` +
        `${tuples.join(",\n  ")}`,
      params,
      label: table,
    });
  }
  return out;
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
  readonly statements: readonly Statement[];
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
  select: Filter,
  remove: Filter = select,
): Promise<TableStatements> {
  const outcome = await source.query(
    `SELECT * FROM public.${table} WHERE ${select.text}`,
    select.params,
  );
  const selected = rowsOf(outcome);
  const oids = outcome.kind === "rows" ? outcome.oids ?? [] : [];
  return {
    count: { table, rows: selected.rows.length },
    statements: [
      {
        sql: `DELETE FROM public.${table} WHERE ${remove.text}`,
        params: remove.params,
        label: table,
      },
      ...insertsOf(table, selected.columns, selected.rows, oids),
    ],
  };
}

/** Условие с параметрами: текст с `$n` и значения к нему. */
export interface Filter {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** Фильтр строк клиента. */
export function clientWhere(clientId: number): Filter {
  return { text: "client_id = $1", params: [clientId] };
}

/**
 * Фильтр по множеству spreadsheet_id. Идентификатор — строка (у Google
 * это `1BxiMVs0XRA5…`), и уходит она параметром: приведение к числу
 * выбросило бы их все и дало тихую недокопию, а подстановка в текст
 * зависела бы от содержимого чужого идентификатора.
 *
 * Пустое множество даёт предикат `false`: `IN ()` — синтаксическая
 * ошибка, а «таблиц у клиента нет» — штатный случай.
 */
export function spreadsheetWhere(ids: readonly string[]): Filter {
  if (ids.length === 0) return { text: "false", params: [] };
  const places = ids.map((_id, at) => `$${at + 1}`).join(", ");
  return { text: `spreadsheet_id IN (${places})`, params: [...ids] };
}

/** Идентификаторы таблиц клиента на стороне, где выполняется запрос. */
export async function spreadsheetIds(
  session: SqlSession,
  clientId: number,
): Promise<readonly string[]> {
  return firstColumn(
    await session.query(
      "SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id = $1",
      [clientId],
    ),
  );
}
