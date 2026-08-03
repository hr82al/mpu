/**
 * Модель книги .xlsx и её разбор: список листов в порядке книги,
 * типизированные значения ячеек, формулы, merged-области, фактические
 * размеры листов. Книга разбирается в память целиком (контракт спеки).
 */

import { unzip, ZipError } from "./zip.ts";
import {
  attr,
  children,
  firstChild,
  parseXml,
  textContent,
  type XmlElement,
  XmlError,
} from "./xml.ts";
import { parseColLetters } from "./range.ts";

/** Значение ячейки после типизации OOXML. */
export type CellValue = string | number | boolean | null;

/** Ячейка книги: значение и формула, если ячейка ею является. */
export interface Cell {
  readonly value: CellValue;
  /** Текст формулы с ведущим «=»; у не-формул ключа нет. */
  readonly formula?: string;
}

/** Лист книги с фактическими размерами и словарём ячеек. */
export interface Sheet {
  readonly title: string;
  /** 0-based позиция листа в книге. */
  readonly index: number;
  /** Фактический максимум встреченных ячеек (с учётом merge). */
  readonly rows: number;
  readonly cols: number;
  /** Явные и merge-созданные ячейки по ключу `cellKey(col, row)`. */
  readonly cells: ReadonlyMap<string, Cell>;
}

/** Разобранная книга: листы в порядке объявления в workbook.xml. */
export interface Workbook {
  readonly sheets: readonly Sheet[];
}

/**
 * Ошибка формата книги; message — причина в скобках сообщения
 * «not a valid xlsx file: "<путь>" (<причина>)».
 */
export class WorkbookError extends Error {
  override name = "WorkbookError";
}

/** Ключ ячейки в `Sheet.cells`; координаты 1-based. */
export function cellKey(col: number, row: number): string {
  return `${col}:${row}`;
}

/** Лист по точному имени (регистрозависимо, как в оригинале). */
export function findSheet(wb: Workbook, title: string): Sheet | undefined {
  return wb.sheets.find((sheet) => sheet.title === title);
}

/** Разбирает байты .xlsx-файла. Ошибки формата — `WorkbookError`. */
export async function parseWorkbook(bytes: Uint8Array): Promise<Workbook> {
  let parts: Map<string, Uint8Array>;
  try {
    parts = await unzip(bytes);
  } catch (err) {
    if (err instanceof ZipError) {
      throw new WorkbookError(err.message, { cause: err });
    }
    throw err;
  }
  return parseWorkbookParts(parts);
}

/**
 * Разбирает книгу из распакованного словаря частей архива. Отдельная
 * точка входа для тестов граничных случаев — без сборки zip.
 */
export function parseWorkbookParts(
  parts: ReadonlyMap<string, Uint8Array>,
): Workbook {
  const workbookXml = readPart(parts, "xl/workbook.xml");
  if (workbookXml === undefined) {
    throw new WorkbookError("missing xl/workbook.xml");
  }
  const relTargets = parseRels(parts);
  const shared = parseSharedStrings(parts);

  const sheetsEl = firstChild(workbookXml, "sheets");
  if (sheetsEl === undefined) {
    throw new WorkbookError("missing sheets in xl/workbook.xml");
  }
  const sheets: Sheet[] = [];
  for (const sheetEl of children(sheetsEl, "sheet")) {
    const title = attr(sheetEl, "name");
    if (title === undefined) {
      throw new WorkbookError("sheet without name in xl/workbook.xml");
    }
    const relId = attr(sheetEl, "id");
    const target = relId === undefined ? undefined : relTargets.get(relId);
    const sheetXml = target === undefined ? undefined : readPart(parts, target);
    if (sheetXml === undefined) {
      throw new WorkbookError(`missing worksheet part for sheet "${title}"`);
    }
    sheets.push(parseSheet(sheetXml, title, sheets.length, shared));
  }
  return { sheets };
}

/** Часть архива как XML-дерево; отсутствие — `undefined`. */
function readPart(
  parts: ReadonlyMap<string, Uint8Array>,
  name: string,
): XmlElement | undefined {
  const bytes = parts.get(name);
  if (bytes === undefined) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new WorkbookError(`malformed XML: ${name}: invalid UTF-8`, {
      cause: err,
    });
  }
  try {
    return parseXml(text);
  } catch (err) {
    if (err instanceof XmlError) {
      throw new WorkbookError(`malformed XML: ${name}: ${err.message}`, {
        cause: err,
      });
    }
    throw err;
  }
}

/** Словарь связей книги: Id → нормализованное имя части. */
function parseRels(
  parts: ReadonlyMap<string, Uint8Array>,
): Map<string, string> {
  const targets = new Map<string, string>();
  const rels = readPart(parts, "xl/_rels/workbook.xml.rels");
  if (rels === undefined) return targets;
  for (const rel of children(rels, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id === undefined || target === undefined) continue;
    const clean = target.startsWith("/") ? target.slice(1) : target;
    targets.set(id, clean.startsWith("xl/") ? clean : `xl/${clean}`);
  }
  return targets;
}

function parseSharedStrings(
  parts: ReadonlyMap<string, Uint8Array>,
): readonly string[] {
  const sst = readPart(parts, "xl/sharedStrings.xml");
  if (sst === undefined) return [];
  return children(sst, "si").map(joinT);
}

/**
 * Склейка rich text: текст всех вложенных `<t>` без форматирования.
 * Пробельные узлы между `<r>` не входят — текст несут только `<t>`.
 * Фонетические аннотации (`rPh`, фуригана) — не текст ячейки и
 * пропускаются, как в оригинале.
 */
function joinT(el: XmlElement): string {
  if (el.name === "t") return textContent(el);
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string" || child.name === "rPh") continue;
    out += joinT(child);
  }
  return out;
}

function parseSheet(
  root: XmlElement,
  title: string,
  index: number,
  shared: readonly string[],
): Sheet {
  const cells = new Map<string, Cell>();
  let maxRow = 0;
  let maxCol = 0;
  const put = (col: number, row: number, cell: Cell): void => {
    cells.set(cellKey(col, row), cell);
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  };

  const sheetData = firstChild(root, "sheetData");
  const rowEls = sheetData === undefined ? [] : children(sheetData, "row");
  let rowNumber = 0;
  for (const rowEl of rowEls) {
    rowNumber = numberAttr(rowEl, "r") ?? rowNumber + 1;
    let colNumber = 0;
    for (const cellEl of children(rowEl, "c")) {
      const addr = parseCellAddr(attr(cellEl, "r"));
      const col = addr?.col ?? colNumber + 1;
      const row = addr?.row ?? rowNumber;
      colNumber = col;
      put(col, row, readCell(cellEl, shared));
    }
  }

  const merges = firstChild(root, "mergeCells");
  const mergeEls = merges === undefined ? [] : children(merges, "mergeCell");
  for (const mergeEl of mergeEls) {
    applyMerge(attr(mergeEl, "ref"), cells, put);
  }
  return { title, index, rows: maxRow, cols: maxCol, cells };
}

/**
 * Копирует значение якорной (верхней-левой) ячейки на всю merged-
 * область: без формулы, существующие явные ячейки не перезаписываются
 * (preserve-отклонение спеки: данные файла не затираются). Область без
 * якорной ячейки или с нечитаемым ref игнорируется молча (контракт
 * спеки).
 */
function applyMerge(
  ref: string | undefined,
  cells: ReadonlyMap<string, Cell>,
  put: (col: number, row: number, cell: Cell) => void,
): void {
  if (ref === undefined) return;
  const match = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(ref);
  if (match === null) return;
  const colA = parseColLetters(match[1]);
  const colB = parseColLetters(match[3]);
  if (colA === null || colB === null) return;
  const rowA = Number.parseInt(match[2], 10);
  const rowB = Number.parseInt(match[4], 10);
  const startCol = Math.min(colA, colB);
  const endCol = Math.max(colA, colB);
  const startRow = Math.min(rowA, rowB);
  const endRow = Math.max(rowA, rowB);
  const anchor = cells.get(cellKey(startCol, startRow));
  if (anchor === undefined) return;
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (!cells.has(cellKey(col, row))) put(col, row, { value: anchor.value });
    }
  }
}

/** Числовой атрибут: нечитаемое значение приравнено к отсутствию. */
function numberAttr(el: XmlElement, name: string): number | undefined {
  const raw = attr(el, name);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return value >= 1 ? value : undefined;
}

function parseCellAddr(
  raw: string | undefined,
): { readonly col: number; readonly row: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^([A-Za-z]+)(\d+)$/.exec(raw);
  if (match === null) return undefined;
  const col = parseColLetters(match[1]);
  const row = Number.parseInt(match[2], 10);
  if (col === null || row < 1) return undefined;
  return { col, row };
}

/** Грамматика числа оригинала: float(3) Python, без inf/nan/hex. */
const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function readCell(cellEl: XmlElement, shared: readonly string[]): Cell {
  const type = attr(cellEl, "t") ?? "n";
  const vEl = firstChild(cellEl, "v");
  const raw = vEl === undefined ? undefined : textContent(vEl);
  const formulaEl = firstChild(cellEl, "f");
  const formulaText = formulaEl === undefined ? "" : textContent(formulaEl);
  const value = cellValue(cellEl, type, raw, shared);
  // Ключ formula есть только у реальных формул: у зависимых ячеек
  // shared/array-формул тела нет — и формулы наружу нет.
  return formulaText === "" ? { value } : { value, formula: `=${formulaText}` };
}

function cellValue(
  cellEl: XmlElement,
  type: string,
  raw: string | undefined,
  shared: readonly string[],
): CellValue {
  switch (type) {
    case "s": {
      if (raw === undefined || raw === "") return null;
      const index = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : -1;
      if (index < 0 || index >= shared.length) {
        throw new WorkbookError(`bad shared string index "${raw}"`);
      }
      return shared[index];
    }
    case "inlineStr": {
      const is = firstChild(cellEl, "is");
      return is === undefined ? null : joinT(is);
    }
    case "b":
      if (raw === undefined || raw === "") return null;
      return raw === "1" || raw === "true";
    case "e":
    case "str":
    case "d":
      return raw === undefined || raw === "" ? null : raw;
    default: {
      // Числовая ячейка: int/float; нечисловой raw — сырая строка.
      if (raw === undefined || raw.trim() === "") return null;
      return NUMBER_RE.test(raw.trim()) ? Number(raw) : raw;
    }
  }
}
