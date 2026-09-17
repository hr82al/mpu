/**
 * Пять видов вывода `mpu kiten ls` (`docs/specs/kiten-ls.md`): сырой JSON
 * из шести полей, шаблон `--format`, `[title](url)` построчно, GFM-таблица
 * и человекочитаемая таблица по умолчанию.
 *
 * Отдельно от команды, потому что состав данных вывода один (`LsRow`), а
 * видов пять — общий модуль избавляет от разъезда правил экранирования и
 * пустой выдачи между ними. Рендер чист: ни сети, ни диска, ни часов.
 */

import { z } from "@zod/zod";

/**
 * Строка выдачи — то, что знает о карточке вывод. `column`/`columnMapped`
 * в `--json` не попадают (спека, «Виды вывода»): их печатают только
 * `--md`, `--format` и таблица по умолчанию.
 */
export const lsRowSchema = z.object({
  id: z.number().int().describe("id карточки"),
  state: z.string().describe("метка этапа: queued, in progress, done"),
  due_date: z.string().nullable().describe("срок как пришёл от сервера"),
  updated: z.string().nullable().describe("момент последней активности"),
  title: z.string().describe("название карточки"),
  url: z.string().describe("web-адрес карточки"),
  column: z.string().describe(
    "название колонки по локальному кэшу; промах кэша — id числом; колонки нет — пусто",
  ),
  columnMapped: z.string().describe(
    "метка из KITEN_COLUMN_MAP по id либо названию колонки; нет в карте — column",
  ),
});

export type LsRow = z.infer<typeof lsRowSchema>;

/** Ключи `--json` в порядке печати — ровно шесть, без колонки (спека). */
const JSON_KEYS = [
  "id",
  "state",
  "due_date",
  "updated",
  "title",
  "url",
] as const;

/** Колонки GFM-таблицы и человекочитаемой таблицы по умолчанию. */
const TABLE_COLUMNS = ["ID", "STATE", "COLUMN", "DUE", "TITLE", "URL"];

/** Плейсхолдеры `--format`; неизвестный токен остаётся как есть. */
const PLACEHOLDER = /\{(n|id|title|url|state|due|column|column_mapped)\}/g;

/** `--json`: отступ 2, юникод как есть, пусто — `[]`. */
export function renderLsJson(rows: readonly LsRow[]): string {
  const view = rows.map((row) =>
    Object.fromEntries(JSON_KEYS.map((key) => [key, row[key]]))
  );
  return `${JSON.stringify(view, null, 2)}\n`;
}

/**
 * `--format TPL`: строка на карточку, нумерация с 1. Подстановка —
 * текстовая замена одним проходом: то, что попало в значение плейсхолдера
 * (например, `{n}` внутри заголовка), второй раз не разбирается.
 */
export function renderLsFormat(
  rows: readonly LsRow[],
  template: string,
): string {
  if (rows.length === 0) return "";
  const lines = rows.map((row, index) => applyTemplate(template, row, index));
  return `${lines.join("\n")}\n`;
}

/** `--only-url`: `[title](url)`; `[`/`]` в title экранируются. */
export function renderLsOnlyUrl(rows: readonly LsRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((row) => `[${escapeBrackets(row.title)}](${row.url})`);
  return `${lines.join("\n")}\n`;
}

/**
 * `--md`: GFM-таблица; `|` в ячейках экранируется, переводы строк — в
 * пробел. Пустая выдача — шапка и разделитель без строк (спека).
 */
export function renderLsMarkdown(rows: readonly LsRow[]): string {
  const header = `| ${TABLE_COLUMNS.join(" | ")} |`;
  const divider = `| ${TABLE_COLUMNS.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${markdownCells(row).join(" | ")} |`);
  return `${[header, divider, ...body].join("\n")}\n`;
}

/** Таблица по умолчанию: ширина по содержимому, оформление — свобода. */
export function renderLsTable(rows: readonly LsRow[]): string {
  if (rows.length === 0) return "(нет карточек)\n";
  const cells = [TABLE_COLUMNS, ...rows.map(tableCells)];
  const widths = columnWidths(cells);
  const table = cells
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index])).join("  ")
        .trimEnd()
    )
    .join("\n");
  return `${table}\n(${rows.length} cards)\n`;
}

function applyTemplate(template: string, row: LsRow, index: number): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    switch (name) {
      case "n":
        return String(index + 1);
      case "id":
        return String(row.id);
      case "title":
        return row.title;
      case "url":
        return row.url;
      case "state":
        return row.state;
      case "due":
        return dueDateOnly(row.due_date);
      case "column":
        return row.column;
      case "column_mapped":
        return row.columnMapped;
      default:
        return match;
    }
  });
}

function markdownCells(row: LsRow): readonly string[] {
  return tableCells(row).map(escapeMarkdownCell);
}

function tableCells(row: LsRow): readonly string[] {
  return [
    String(row.id),
    row.state,
    row.column,
    dueDateOnly(row.due_date),
    row.title,
    row.url,
  ];
}

/** Календарная часть срока; срока нет — пусто (плейсхолдер `{due}`, `--md`). */
function dueDateOnly(dueDate: string | null): string {
  return dueDate === null ? "" : dueDate.slice(0, 10);
}

function escapeBrackets(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownCell(cell: string): string {
  return cell.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function columnWidths(rows: readonly (readonly string[])[]): readonly number[] {
  const widths = new Array<number>(rows[0].length).fill(0);
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], [...cell].length);
    });
  }
  return widths;
}
