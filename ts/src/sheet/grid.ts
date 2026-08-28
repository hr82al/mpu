/**
 * Координаты мини-языка (`docs/specs/sheet-batch.md`, «Диапазон»):
 * токен RANGE → GridRange, токен DIM → DimensionRange.
 *
 * Свой разбор спана, а не `boxOf` из `a1.ts`: тот закрывает открытые
 * границы фактическим размером листа — это нужно вырезке из кэша, а
 * здесь ровно наоборот. Открытая граница обязана **не попасть** в
 * запрос: `H2:H` значит «до конца столбца», и подстановка `endRowIndex`
 * ограничила бы операцию сегодняшним размером листа.
 */

import { UsageError } from "../command/mod.ts";
import { columnNumber } from "./a1.ts";

/** Лист таблицы глазами компилятора: имя и его id. */
export interface SheetRef {
  readonly title: string;
  readonly sheetId: number;
}

/** Прямоугольник Sheets API; открытая граница отсутствует. */
export interface GridRange {
  readonly sheetId: number;
  readonly startRowIndex?: number;
  readonly endRowIndex?: number;
  readonly startColumnIndex?: number;
  readonly endColumnIndex?: number;
}

/** Полоса строк или столбцов Sheets API. */
export interface DimensionRange {
  readonly sheetId: number;
  readonly dimension: "ROWS" | "COLUMNS";
  readonly startIndex: number;
  readonly endIndex: number;
}

/** Разобранный токен: имя листа (если названо) и спан (если задан). */
interface Located {
  readonly title: string | undefined;
  readonly span: string | undefined;
  readonly raw: string;
}

/** Одиночная ячейка в R1C1: `r5c8`, регистр любой. */
const R1C1 = /^r(\d+)c(\d+)$/i;
/** Спан-подобный токен без листа: с двоеточием, ссылкой или номером. */
const SPAN_LIKE = /^([A-Za-z]{1,3}\d*|\d+)$/;
/** Часть спана: буквы столбца и/или номер строки. */
const PART = /^([A-Za-z]{0,3})(\d*)$/;

/**
 * Делит токен на имя листа и спан по правилам спеки. Токен без `!`
 * читается спаном, если задан лист-умолчание; иначе спан-подобный
 * токен — ошибка, а прочий токен — имя листа целиком.
 */
export function locate(raw: string, defaultSheet?: string): Located {
  const split = splitBang(raw);
  if (split !== undefined) {
    if (split.title === "") throw noSheetName(raw);
    return {
      title: split.title,
      span: split.span === "" ? undefined : split.span,
      raw,
    };
  }
  if (defaultSheet !== undefined) {
    return { title: defaultSheet, span: raw, raw };
  }
  if (raw.includes(":") || SPAN_LIKE.test(raw) || R1C1.test(raw)) {
    throw noSheetName(raw);
  }
  return { title: raw, span: undefined, raw };
}

function noSheetName(raw: string): UsageError {
  return new UsageError(`нет имени листа в '${raw}' и не задан -n/--sheet`);
}

/** Делит по `!`; имя в кавычках может содержать `!` и удвоенный `'`. */
function splitBang(
  raw: string,
): { readonly title: string; readonly span: string } | undefined {
  if (raw.startsWith("'")) {
    for (let index = 1; index < raw.length; index++) {
      if (raw[index] !== "'") continue;
      if (raw[index + 1] === "'") {
        index++;
        continue;
      }
      if (raw[index + 1] !== "!") break;
      return {
        title: raw.slice(1, index).replaceAll("''", "'"),
        span: raw.slice(index + 2),
      };
    }
    return undefined;
  }
  const bang = raw.indexOf("!");
  return bang === -1
    ? undefined
    : { title: raw.slice(0, bang), span: raw.slice(bang + 1) };
}

/** Лист по имени; неизвестное имя — ошибка компиляции. */
export function sheetOf(
  sheets: readonly SheetRef[],
  title: string,
): SheetRef {
  const found = sheets.find((sheet) => sheet.title === title);
  if (found === undefined) {
    throw new UsageError(`лист '${title}' не найден в таблице`);
  }
  return found;
}

/** Токен RANGE → GridRange; спан не задан — весь лист. */
export function gridRange(
  raw: string,
  sheets: readonly SheetRef[],
  defaultSheet?: string,
): GridRange {
  const located = locate(raw, defaultSheet);
  if (located.title === undefined) throw noSheetName(raw);
  const sheet = sheetOf(sheets, located.title);
  return { sheetId: sheet.sheetId, ...spanBounds(located.span, raw) };
}

/** Границы спана; порядок ключей — как в ответах Sheets API. */
function spanBounds(
  span: string | undefined,
  raw: string,
): Omit<GridRange, "sheetId"> {
  if (span === undefined) return {};
  const r1c1 = R1C1.exec(span);
  if (r1c1 !== null) {
    const row = Number(r1c1[1]);
    const column = Number(r1c1[2]);
    return {
      startRowIndex: row - 1,
      endRowIndex: row,
      startColumnIndex: column - 1,
      endColumnIndex: column,
    };
  }
  const [start, end] = span.includes(":")
    ? [span.slice(0, span.indexOf(":")), span.slice(span.indexOf(":") + 1)]
    : [span, span];
  const from = part(start, raw);
  const to = part(end, raw);
  if (from.letters === undefined && from.digits === undefined) {
    throw new UsageError(`невалидный диапазон '${raw}'`);
  }
  // Нумерация A1 начинается с единицы: `A0` — не «нулевая строка», а
  // ошибка ввода. Без проверки индекс уезжал бы в запрос
  // отрицательным и отбивался уже webapp'ом, кодом 1 вместо 2.
  for (const value of [from.digits, to.digits, from.letters, to.letters]) {
    if (value !== undefined && value < 1) {
      throw new UsageError(`невалидный диапазон '${raw}'`);
    }
  }
  const bounds: Record<string, number> = {};
  if (from.digits !== undefined) bounds.startRowIndex = from.digits - 1;
  if (to.digits !== undefined) bounds.endRowIndex = to.digits;
  if (from.letters !== undefined) bounds.startColumnIndex = from.letters - 1;
  if (to.letters !== undefined) bounds.endColumnIndex = to.letters;
  return bounds;
}

/** Часть спана: номер столбца и номер строки, каждый — если назван. */
function part(
  text: string,
  raw: string,
): { readonly letters?: number; readonly digits?: number } {
  const match = PART.exec(text);
  if (match === null) throw new UsageError(`невалидный диапазон '${raw}'`);
  const [, letters, digits] = match;
  return {
    letters: letters === "" ? undefined : columnNumber(letters),
    digits: digits === "" ? undefined : Number(digits),
  };
}

/**
 * Токен DIM → DimensionRange. Размерность задаёт глагол (`cols`/`rows`),
 * а не токен: буквы допустимы только у столбцов, номера — у обеих.
 */
export function dimensionRange(
  raw: string,
  dimension: "ROWS" | "COLUMNS",
  sheets: readonly SheetRef[],
  defaultSheet?: string,
): DimensionRange {
  const located = locate(raw, defaultSheet);
  if (located.title === undefined || located.span === undefined) {
    throw noSheetName(raw);
  }
  const sheet = sheetOf(sheets, located.title);
  const span = located.span;
  const [start, end] = span.includes(":")
    ? [span.slice(0, span.indexOf(":")), span.slice(span.indexOf(":") + 1)]
    : [span, span];
  return {
    sheetId: sheet.sheetId,
    dimension,
    startIndex: indexOf(start, dimension) - 1,
    endIndex: indexOf(end, dimension),
  };
}

/** Индекс полосы (1-based): буква столбца либо номер. */
function indexOf(text: string, dimension: "ROWS" | "COLUMNS"): number {
  if (/^\d+$/.test(text)) return Number(text);
  if (/^[A-Za-z]{1,3}$/.test(text)) {
    if (dimension === "ROWS") {
      throw new UsageError(`плохой индекс '${text}' для ROWS`);
    }
    return columnNumber(text);
  }
  throw new UsageError(`плохой индекс '${text}' для ${dimension}`);
}
