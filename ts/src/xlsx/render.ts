/**
 * Текстовые рендеры результатов команд xlsx: get в tsv/raw и две формы
 * ls. Все функции чистые «данные → строка»; вызывающий пишет строку как
 * есть. Формы «результат как JSON» здесь нет: её даёт точка входа из
 * самого результата.
 */

import type { CellValue } from "./workbook.ts";

/** Режим `--render`: что попадает в ячейку результата get. */
export type RenderMode = "both" | "values" | "formulas";

/** Ячейка результата get: адрес с листом, значение, формула. */
export interface OutputCell {
  readonly range: string;
  /** Отсутствует в режиме `--render formulas`. */
  readonly value?: CellValue;
  /** Есть ⇔ у ячейки есть формула. */
  readonly formula?: string;
}

/** Строка листа для ls; узкий интерфейс на стороне рендера. */
export interface SheetInfo {
  readonly title: string;
  readonly index: number;
  readonly rows: number;
  readonly cols: number;
}

/** TSV get: шапка по режиму, строка на ячейку, финальный `\n`. */
export function renderGetTsv(
  cells: readonly OutputCell[],
  mode: RenderMode,
): string {
  const header = ["range", ...fieldNames(mode)].join("\t");
  const lines = cells.map((cell) =>
    [escapeTsv(cell.range), ...fields(cell, mode).map(escapeTsv)].join("\t")
  );
  return [header, ...lines].map((line) => `${line}\n`).join("");
}

/**
 * Raw get: ровно одна ячейка — голое значение без `\n`; несколько —
 * строка на ячейку (поля как в tsv, но без шапки и колонки range).
 * Значения не экранируются — печатаются как есть.
 */
export function renderGetRaw(
  cells: readonly OutputCell[],
  mode: RenderMode,
): string {
  if (cells.length === 1) {
    // «Голое значение»: одно поле без табов — в режиме formulas это
    // формула, иначе значение (подтверждено golden get-raw.txt).
    const cell = cells[0];
    return mode === "formulas" ? cell.formula ?? "" : stringValue(cell.value);
  }
  return cells.map((cell) => `${fields(cell, mode).join("\t")}\n`).join("");
}

/** ls по умолчанию: `{title}\n` на лист. */
export function renderLsPlain(sheets: readonly SheetInfo[]): string {
  return sheets.map((sheet) => `${sheet.title}\n`).join("");
}

/** ls -l: `{title:<w}  {rows}×{cols:>w}  #{index}`, ширины по code points. */
export function renderLsLong(sheets: readonly SheetInfo[]): string {
  const titleWidth = Math.max(
    0,
    ...sheets.map((sheet) => codePoints(sheet.title)),
  );
  const colsWidth = Math.max(
    0,
    ...sheets.map((sheet) => String(sheet.cols).length),
  );
  return sheets.map((sheet) => {
    const pad = " ".repeat(titleWidth - codePoints(sheet.title));
    const title = sheet.title + pad;
    const cols = String(sheet.cols).padStart(colsWidth);
    return `${title}  ${sheet.rows}×${cols}  #${sheet.index}\n`;
  }).join("");
}

/**
 * Строковый рендер значения для tsv/raw. Bool печатается как
 * `True`/`False` — preserve-отклонение спеки (строковый рендер
 * оригинала; differential харнесс-команды обязан быть пустым;
 * идея унификации с JSON true/false — в журнале переезда).
 */
function stringValue(value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

// Шапка tsv в режимах values/formulas спекой не зафиксирована
// (шаблон «range\tvalue[\tformula]» описывает both); выбрано
// «range\tvalue» / «range\tformula» — вопрос спецификатору в отчёте.
function fieldNames(mode: RenderMode): readonly string[] {
  switch (mode) {
    case "both":
      return ["value", "formula"];
    case "values":
      return ["value"];
    case "formulas":
      return ["formula"];
    default:
      return unreachable(mode);
  }
}

function fields(cell: OutputCell, mode: RenderMode): readonly string[] {
  const formula = cell.formula ?? "";
  switch (mode) {
    case "both":
      return [stringValue(cell.value), formula];
    case "values":
      return [stringValue(cell.value)];
    case "formulas":
      return [formula];
    default:
      return unreachable(mode);
  }
}

function escapeTsv(field: string): string {
  return field
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function codePoints(text: string): number {
  return [...text].length;
}

function unreachable(mode: never): never {
  throw new Error(`unknown render mode ${String(mode)}`);
}
