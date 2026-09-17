/**
 * A1-диапазоны (`platform/webapp-http.md`, «A1-диапазоны»): разбор,
 * сборка и нормализация.
 *
 * Разбор зеркален сборке: имя листа с символом вне `[A-Za-z0-9_]`
 * берётся в одинарные кавычки, `'` внутри удваивается. Иначе имя
 * `Лист 'один'` уходило бы в webapp неразличимо с чужим.
 */

import { UsageError } from "../command/mod.ts";

/** Имя листа, не требующее кавычек. */
const PLAIN_NAME = /^[A-Za-z0-9_]+$/;

/** Ссылка на ячейку или строку: `A`, `AB12`, `42`. */
const CELL_LIKE = /^([A-Za-z]{1,3}\d*|\d+)$/;

/** Span диапазона: `A1`, `A1:C3`, `A:A`, `1:5`, `A1:A`. */
const SPAN = /^[A-Za-z]{0,3}\d*(:[A-Za-z]{0,3}\d*)?$/;

/** Разобранный диапазон: лист и span внутри него. */
export interface Range {
  /** Имя листа; не названо в строке — `undefined`. */
  readonly tab?: string;
  /** Span внутри листа; весь лист — `undefined`. */
  readonly span?: string;
}

/**
 * Строка не является диапазоном: пустая, `Лист!`, `Лист!A1:`. Это
 * ошибка ввода, а не сбой разбора: у неё код выхода 2 и одна строка
 * вместо трейсбека (`sheet.md`, отклонение `fix`).
 */
export class BadRangeError extends UsageError {
  override name = "BadRangeError";
  constructor(readonly raw: string) {
    super(`невалидный диапазон '${raw}'`);
  }
}

/** Диапазон назван без листа, а листа-умолчания нет: ошибка ввода. */
export class NoTabError extends UsageError {
  override name = "NoTabError";
  constructor(readonly raw: string) {
    super(
      `диапазон '${raw}' без имени листа; попробуй: --sheet TAB или ` +
        "префикс 'Лист!'",
    );
  }
}

/**
 * Разбирает строку в диапазон. Строка без `!`, не похожая на ссылку и
 * без `:`, — имя листа целиком: так набирают «весь лист Отчёт».
 */
export function parseRange(raw: string): Range {
  const text = raw.trim();
  if (text === "") throw new BadRangeError(raw);
  const bang = splitTab(text);
  if (bang === undefined) {
    if (!text.includes(":") && !CELL_LIKE.test(text)) return { tab: text };
    if (!SPAN.test(text) || text === ":") throw new BadRangeError(raw);
    return { span: text };
  }
  if (bang.tab === "") throw new BadRangeError(raw);
  if (bang.span === "") return { tab: bang.tab };
  if (!SPAN.test(bang.span) || bang.span.endsWith(":")) {
    throw new BadRangeError(raw);
  }
  return { tab: bang.tab, span: bang.span };
}

/**
 * Делит строку на имя листа и span по последнему `!` вне кавычек.
 * `!` в имени листа возможен только внутри кавычек — оттуда и правило.
 */
function splitTab(
  text: string,
): { readonly tab: string; readonly span: string } | undefined {
  if (text.startsWith("'")) {
    const end = closingQuote(text);
    if (end === -1) throw new BadRangeError(text);
    if (text[end + 1] !== "!") throw new BadRangeError(text);
    return {
      tab: text.slice(1, end).replaceAll("''", "'"),
      span: text.slice(end + 2),
    };
  }
  const bang = text.indexOf("!");
  if (bang === -1) return undefined;
  return { tab: text.slice(0, bang), span: text.slice(bang + 1) };
}

/** Позиция закрывающей кавычки имени: удвоенная `''` его не закрывает. */
function closingQuote(text: string): number {
  for (let index = 1; index < text.length; index++) {
    if (text[index] !== "'") continue;
    if (text[index + 1] === "'") {
      index++;
      continue;
    }
    return index;
  }
  return -1;
}

/** Имя листа в форме A1: кавычки — только там, где они обязательны. */
export function quoteTab(tab: string): string {
  if (PLAIN_NAME.test(tab)) return tab;
  return `'${tab.replaceAll("'", "''")}'`;
}

/** Собирает диапазон обратно в строку A1. */
export function formatRange(range: Range): string {
  if (range.tab === undefined) return range.span ?? "";
  const tab = quoteTab(range.tab);
  return range.span === undefined ? tab : `${tab}!${range.span}`;
}

/** Номер колонки (1-based) из букв A1: `A` → 1, `AA` → 27. */
export function columnNumber(letters: string): number {
  let value = 0;
  for (const letter of letters.toUpperCase()) {
    value = value * 26 + (letter.charCodeAt(0) - 64);
  }
  return value;
}

/** Буквы колонки по номеру (1-based): 1 → `A`, 27 → `AA`. */
export function columnLetters(index: number): string {
  let rest = index;
  let letters = "";
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/** Прямоугольник внутри листа: границы в 1-based координатах. */
export interface Box {
  readonly firstRow: number;
  readonly firstColumn: number;
  readonly lastRow: number;
  readonly lastColumn: number;
}

/**
 * Границы span'а в координатах листа. Открытые концы (`A:A`, `1:5`,
 * `A1:A`) закрываются фактическими границами листа — теми, что пришли
 * метаданными: закрытая форма нужна и для вырезки, и для ответа.
 */
export function boxOf(
  span: string | undefined,
  rows: number,
  cols: number,
): Box {
  if (span === undefined) {
    return { firstRow: 1, firstColumn: 1, lastRow: rows, lastColumn: cols };
  }
  const [start, end] = span.includes(":") ? span.split(":") : [span, span];
  const from = cellOf(start, 1, 1);
  const to = cellOf(end, rows, cols);
  return {
    firstRow: Math.min(from.row, to.row),
    firstColumn: Math.min(from.column, to.column),
    lastRow: Math.max(from.row, to.row),
    lastColumn: Math.max(from.column, to.column),
  };
}

/** Координаты конца span'а; пропущенная часть берётся из умолчания. */
function cellOf(
  cell: string,
  defaultRow: number,
  defaultColumn: number,
): { readonly row: number; readonly column: number } {
  const letters = /^[A-Za-z]*/.exec(cell)?.[0] ?? "";
  const digits = cell.slice(letters.length);
  return {
    row: digits === "" ? defaultRow : Number(digits),
    column: letters === "" ? defaultColumn : columnNumber(letters),
  };
}

/** Закрытая форма адреса по границам: `Sheet1!A1:B2`. */
export function closedAddress(tab: string, box: Box): string {
  const from = `${columnLetters(box.firstColumn)}${box.firstRow}`;
  const to = `${columnLetters(box.lastColumn)}${box.lastRow}`;
  return `${quoteTab(tab)}!${from}:${to}`;
}
