/**
 * Ссылки на диапазоны в A1-нотации: разбор пользовательских токенов,
 * префиксация именем листа (`--sheet`), нормализация и клэмп открытых
 * границ к фактическим размерам листа (контракт спеки xlsx.md).
 */

import { UsageError } from "./errors.ts";

/** Пределы сетки Excel; ссылки за ними считаются невалидными. */
const MAX_COL = 16384; // XFD
const MAX_ROW = 1048576;

/**
 * Прямоугольник в 1-based координатах; `undefined` — открытая граница
 * (клэмпится к размеру листа в `resolveArea`).
 */
export interface AreaRef {
  readonly startCol?: number;
  readonly startRow?: number;
  readonly endCol?: number;
  readonly endRow?: number;
}

/** Разобранный токен диапазона: прямоугольник либо целый лист по имени. */
export type RangeTarget =
  | { readonly kind: "wholeSheet"; readonly sheet: string }
  | {
    readonly kind: "area";
    readonly sheet: string | undefined;
    readonly area: AreaRef;
  };

/**
 * Разбирает один токен диапазона: `A1`, `A1:B2`, `A:A`, `1:5`,
 * `Лист!A1`, `'Мой лист'!A1:B2`, голое имя листа. Невалидный токен —
 * `UsageError` (exit 2).
 */
export function parseRangeToken(token: string): RangeTarget {
  if (token === "") throw invalidRange(token);
  if (token.startsWith("'")) {
    const [sheet, rest] = readQuotedSheet(token);
    if (rest === "") return { kind: "wholeSheet", sheet };
    if (!rest.startsWith("!")) throw invalidRange(token);
    return qualifiedArea(token, sheet, rest.slice(1));
  }
  const bang = token.indexOf("!");
  if (bang >= 0) {
    const sheet = token.slice(0, bang);
    if (sheet === "") throw invalidRange(token);
    return qualifiedArea(token, sheet, token.slice(bang + 1));
  }
  const ref = parseRef(token);
  if (ref !== null) return { kind: "area", sheet: undefined, area: ref };
  return { kind: "wholeSheet", sheet: token };
}

/**
 * Префиксует токен именем листа, если в токене нет `!`; имя берётся в
 * кавычки, когда содержит пробел, `'` или `!` (правило спеки).
 * Префиксация строковая: результат заново разбирается вызывающим.
 */
export function prefixRangeToken(token: string, sheet: string): string {
  if (token.includes("!")) return token;
  return `${quoteSheetName(sheet)}!${token}`;
}

/**
 * Нормализует прямоугольник (реверс — в прямой порядок) и клэмпит
 * открытые границы к фактическим размерам листа; заданная граница не
 * уменьшается. `null` — диапазон не задевает ни одной ячейки.
 */
export function resolveArea(
  area: AreaRef,
  rows: number,
  cols: number,
): {
  readonly startCol: number;
  readonly startRow: number;
  readonly endCol: number;
  readonly endRow: number;
} | null {
  const colSpan = resolveAxis(area.startCol, area.endCol, cols);
  const rowSpan = resolveAxis(area.startRow, area.endRow, rows);
  if (colSpan === null || rowSpan === null) return null;
  return {
    startCol: colSpan[0],
    startRow: rowSpan[0],
    endCol: colSpan[1],
    endRow: rowSpan[1],
  };
}

/** Номер колонки в буквы: 1 → A, 27 → AA. */
export function colLetters(col: number): string {
  let out = "";
  let rest = col;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    out = String.fromCharCode(65 + digit) + out;
    rest = Math.trunc((rest - 1) / 26);
  }
  return out;
}

/** Буквы колонки в номер; регистр не важен; за XFD — `null`. */
export function parseColLetters(letters: string): number | null {
  let col = 0;
  for (const ch of letters.toUpperCase()) {
    const digit = ch.charCodeAt(0) - 64;
    if (digit < 1 || digit > 26) return null;
    col = col * 26 + digit;
    if (col > MAX_COL) return null;
  }
  return col === 0 ? null : col;
}

/** Адрес ячейки: (2, 3) → "B3". */
export function cellName(col: number, row: number): string {
  return `${colLetters(col)}${row}`;
}

function invalidRange(token: string): UsageError {
  return new UsageError(`invalid range "${token}"`, {
    hint: "формат A1, A1:B2, A:A, 1:5, Лист!A1 или имя листа целиком",
  });
}

function qualifiedArea(
  token: string,
  sheet: string,
  refPart: string,
): RangeTarget {
  const ref = parseRef(refPart);
  if (ref === null) throw invalidRange(token);
  return { kind: "area", sheet, area: ref };
}

/** Читает `'Имя с ''кавычкой'''`; возвращает имя и остаток токена. */
function readQuotedSheet(token: string): [string, string] {
  let name = "";
  let pos = 1;
  for (;;) {
    const quote = token.indexOf("'", pos);
    if (quote < 0) throw invalidRange(token);
    if (token[quote + 1] === "'") {
      name += token.slice(pos, quote + 1);
      pos = quote + 2;
      continue;
    }
    name += token.slice(pos, quote);
    if (name === "") throw invalidRange(token);
    return [name, token.slice(quote + 1)];
  }
}

interface RefSide {
  readonly col?: number;
  readonly row?: number;
}

/** Разбирает часть после `!`; `null` — на ссылку не похоже. */
function parseRef(ref: string): AreaRef | null {
  const colon = ref.indexOf(":");
  if (colon < 0) {
    const side = parseSide(ref);
    if (side === null || side.col === undefined || side.row === undefined) {
      // Одиночная ссылка обязана быть полной ячейкой: голые буквы или
      // цифры без «:» неотличимы от имени листа.
      return null;
    }
    return {
      startCol: side.col,
      startRow: side.row,
      endCol: side.col,
      endRow: side.row,
    };
  }
  const start = parseSide(ref.slice(0, colon));
  const end = parseSide(ref.slice(colon + 1));
  if (start === null || end === null) return null;
  return {
    startCol: start.col,
    startRow: start.row,
    endCol: end.col,
    endRow: end.row,
  };
}

/** Сторона ссылки: буквы и/или цифры, хотя бы что-то одно. */
function parseSide(side: string): RefSide | null {
  const match = /^([A-Za-z]+)?([0-9]+)?$/.exec(side);
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    return null;
  }
  let col: number | undefined;
  if (match[1] !== undefined) {
    const parsed = parseColLetters(match[1]);
    if (parsed === null) return null;
    col = parsed;
  }
  let row: number | undefined;
  if (match[2] !== undefined) {
    row = Number.parseInt(match[2], 10);
    if (row < 1 || row > MAX_ROW) return null;
  }
  return { col, row };
}

function resolveAxis(
  start: number | undefined,
  end: number | undefined,
  dim: number,
): readonly [number, number] | null {
  if (start !== undefined && end !== undefined) {
    return [Math.min(start, end), Math.max(start, end)];
  }
  if (start !== undefined) return [start, Math.max(dim, start)];
  if (end !== undefined) return [1, end];
  return dim === 0 ? null : [1, dim];
}

function quoteSheetName(name: string): string {
  if (!/[\s'!]/.test(name)) return name;
  return `'${name.replaceAll("'", "''")}'`;
}
