/**
 * Чтение таблицы (`platform/webapp-http.md`): метаданные, whole-tab
 * кэш и вырезка запрошенного span'а.
 *
 * Решение «кэшировать или читать напрямую» принимается ДО загрузки —
 * по оценке `строки × колонки × 16` из метаданных: скачать лист, чтобы
 * узнать, что он слишком велик для кэша, значит заплатить дважды.
 */

import { DomainError } from "../command/mod.ts";
import type { CacheDb } from "../command/mod.ts";
import {
  boxOf,
  closedAddress,
  columnLetters,
  formatRange,
  quoteTab,
  type Range,
} from "./a1.ts";
import {
  type CacheSettings,
  readInfo,
  readTab,
  type TabInfo,
  type TabPayload,
  writeInfo,
  writeTab,
} from "./cache.ts";
import { callWebapp, type WebappDeps } from "./webapp.ts";

/** Байт на ячейку в оценке объёма листа. */
const BYTES_PER_CELL = 16;

/** Слой значений: что именно спрашивается у webapp. */
export type Layer = "values" | "formulas" | "formatted";

/** Как читать: набор слоёв и обход кэша. */
export interface ReadOptions {
  readonly layers: readonly Layer[];
  /** `--refresh`: кэш не читается, но перезаписывается. */
  readonly refresh: boolean;
}

/** Прочитанный диапазон в форме вывода команды. */
export interface RangeResult {
  readonly range: string;
  readonly values?: readonly (readonly unknown[])[];
  readonly formulas?: readonly (readonly unknown[])[];
  readonly formatted?: readonly (readonly unknown[])[];
  readonly fromCache: boolean;
}

/** Всё, что нужно чтению: webapp, кэш-БД, настройки и часы. */
export interface ReadDeps {
  readonly webapp: WebappDeps;
  readonly db: CacheDb;
  readonly settings: CacheSettings;
  readonly nowSeconds: number;
}

/** Метаданные листов: из кэша либо от webapp с перезаписью кэша. */
export async function tabsOf(
  deps: ReadDeps,
  ssId: string,
  refresh: boolean,
): Promise<readonly TabInfo[]> {
  if (!refresh) {
    const cached = readInfo(deps.db, ssId, deps.nowSeconds);
    if (cached !== undefined) return cached;
  }
  const reply = await callWebapp(deps.webapp, "spreadsheets/get", { ssId });
  const tabs = parseTabs(reply);
  writeInfo(deps.db, ssId, tabs, deps.nowSeconds);
  return tabs;
}

/** Разбор ответа `spreadsheets/get`; порядок листов — как в ответе. */
function parseTabs(reply: Readonly<Record<string, unknown>>): TabInfo[] {
  const sheets = Array.isArray(reply.sheets) ? reply.sheets : [];
  return sheets.map((sheet) => {
    const properties = asRecord(asRecord(sheet).properties);
    const grid = asRecord(properties.gridProperties);
    return {
      title: String(properties.title ?? ""),
      sheet_id: Number(properties.sheetId ?? 0),
      rows: Number(grid.rowCount ?? 0),
      cols: Number(grid.columnCount ?? 0),
      index: Number(properties.index ?? 0),
    };
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? value as Readonly<Record<string, unknown>>
    : {};
}

/**
 * Читает диапазоны в порядке, в котором их назвали: у ответа тот же
 * порядок, что у ввода, — иначе оператор не сопоставит их глазами.
 */
export async function readRanges(
  deps: ReadDeps,
  ssId: string,
  ranges: readonly Range[],
  options: ReadOptions,
): Promise<readonly RangeResult[]> {
  const tabs = await tabsOf(deps, ssId, options.refresh);
  const results: RangeResult[] = [];
  for (const range of ranges) {
    results.push(await readOne(deps, ssId, range, options, tabs));
  }
  return results;
}

/** Один диапазон: через кэш листа либо прямым запросом. */
async function readOne(
  deps: ReadDeps,
  ssId: string,
  range: Range,
  options: ReadOptions,
  tabs: readonly TabInfo[],
): Promise<RangeResult> {
  const tabName = range.tab ?? "";
  const info = tabs.find((tab) => tab.title === tabName);
  if (info === undefined) throw noTab(tabName, ssId, tabs);
  if (!cacheable(info, options, deps.settings)) {
    return await directRead(deps, ssId, range, options);
  }
  const payload = await tabPayload(deps, ssId, info, options);
  return sliceTab(range, info, payload.tab, options, payload.fromCache);
}

/** Лист не найден: перечень существующих — то, что чинит вызов. */
function noTab(
  tab: string,
  ssId: string,
  tabs: readonly TabInfo[],
): DomainError {
  const names = tabs.map((item) => item.title).join(", ");
  return new DomainError(
    `лист '${tab}' не найден в spreadsheet ${ssId}; доступные: ${names}`,
  );
}

/**
 * Кэшируется ли лист. `formatted` — никогда: он зависит от locale
 * таблицы, и закэшированный однажды ответ врал бы всем прочим.
 */
function cacheable(
  info: TabInfo,
  options: ReadOptions,
  settings: CacheSettings,
): boolean {
  if (options.layers.includes("formatted")) return false;
  return info.rows * info.cols * BYTES_PER_CELL <= settings.maxTabBytes;
}

/** Лист целиком: из кэша либо двумя запросами с записью в кэш. */
async function tabPayload(
  deps: ReadDeps,
  ssId: string,
  info: TabInfo,
  options: ReadOptions,
): Promise<{ readonly tab: TabPayload; readonly fromCache: boolean }> {
  if (!options.refresh) {
    const cached = await readTab(
      deps.db,
      ssId,
      info.title,
      deps.settings,
      deps.nowSeconds,
    );
    if (cached !== undefined) return { tab: cached, fromCache: true };
  }
  // Имя кавычится тем же правилом, что и везде: `Мой лист!A1:Z1000`
  // Sheets API не разберёт (атом, «A1-диапазоны»).
  const whole = `${quoteTab(info.title)}!A1:${columnLetters(info.cols)}` +
    `${info.rows}`;
  const values = await fetchLayer(deps, ssId, [whole], "values");
  const formulas = await fetchLayer(deps, ssId, [whole], "formulas");
  const payload: TabPayload = {
    values: pad(values[0]?.cells ?? [], info.rows, info.cols),
    formulas: pad(formulas[0]?.cells ?? [], info.rows, info.cols),
    dims: { rows: info.rows, cols: info.cols },
  };
  await writeTab(deps.db, ssId, info.title, payload, deps.nowSeconds);
  return { tab: payload, fromCache: false };
}

/** Ответ webapp по одному слою: адрес и ячейки каждого диапазона. */
async function fetchLayer(
  deps: ReadDeps,
  ssId: string,
  ranges: readonly string[],
  layer: Layer,
): Promise<
  readonly {
    readonly range: string;
    readonly cells: readonly (readonly unknown[])[];
  }[]
> {
  const reply = await callWebapp(
    deps.webapp,
    "spreadsheets/values/batchGet",
    {
      ssId,
      ranges,
      majorDimension: "ROWS",
      valueRenderOption: renderOptionOf(layer),
      dateTimeRenderOption: "SERIAL_NUMBER",
    },
  );
  const list = Array.isArray(reply.valueRanges) ? reply.valueRanges : [];
  return list.map((item) => {
    const record = asRecord(item);
    const cells = Array.isArray(record.values) ? record.values : [];
    return {
      range: String(record.range ?? ""),
      cells: cells as readonly (readonly unknown[])[],
    };
  });
}

/** Имя опции рендера у Sheets API для слоя. */
function renderOptionOf(layer: Layer): string {
  if (layer === "formulas") return "FORMULA";
  return layer === "formatted" ? "FORMATTED_VALUE" : "UNFORMATTED_VALUE";
}

/** Прямое чтение мимо кэша: `formatted` и слишком большие листы. */
async function directRead(
  deps: ReadDeps,
  ssId: string,
  range: Range,
  options: ReadOptions,
): Promise<RangeResult> {
  const address = formatRange(range);
  const result: {
    range: string;
    values?: readonly (readonly unknown[])[];
    formulas?: readonly (readonly unknown[])[];
    formatted?: readonly (readonly unknown[])[];
    fromCache: boolean;
  } = { range: address, fromCache: false };
  for (const layer of options.layers) {
    const answer = await fetchLayer(deps, ssId, [address], layer);
    const first = answer[0];
    if (first !== undefined) result.range = first.range;
    result[layer] = first?.cells ?? [];
  }
  return result;
}

/**
 * Вырезка span'а из закэшированного листа. Адрес нормализуется к
 * закрытой форме: `A:A` в ответе становится `Лист!A1:A1000`, и по нему
 * видно, что именно прочитано.
 */
function sliceTab(
  range: Range,
  info: TabInfo,
  payload: TabPayload,
  options: ReadOptions,
  fromCache: boolean,
): RangeResult {
  const box = boxOf(range.span, payload.dims.rows, payload.dims.cols);
  // Адрес ответа — по фактическим границам: `A1:B5000` на листе в
  // тысячу строк отвечает тысячей строк, и адрес обязан это называть.
  const shown = {
    ...box,
    lastRow: Math.min(box.lastRow, payload.dims.rows),
    lastColumn: Math.min(box.lastColumn, payload.dims.cols),
  };
  const result: {
    range: string;
    values?: readonly (readonly unknown[])[];
    formulas?: readonly (readonly unknown[])[];
    formatted?: readonly (readonly unknown[])[];
    fromCache: boolean;
  } = { range: closedAddress(info.title, shown), fromCache };
  for (const layer of options.layers) {
    if (layer === "formatted") continue;
    const source = layer === "values" ? payload.values : payload.formulas;
    result[layer] = cut(source, box, payload.dims);
  }
  return result;
}

/**
 * Прямоугольник из слоя. Диапазон целиком за границами листа даёт
 * пустой слой — не ошибку: спросить про пустой хвост нормально.
 */
function cut(
  cells: readonly (readonly unknown[])[],
  box: {
    firstRow: number;
    firstColumn: number;
    lastRow: number;
    lastColumn: number;
  },
  dims: { readonly rows: number; readonly cols: number },
): readonly (readonly unknown[])[] {
  if (box.firstRow > dims.rows || box.firstColumn > dims.cols) return [];
  const lastRow = Math.min(box.lastRow, dims.rows);
  const lastColumn = Math.min(box.lastColumn, dims.cols);
  const rows: unknown[][] = [];
  for (let row = box.firstRow; row <= lastRow; row++) {
    const line: unknown[] = [];
    for (let column = box.firstColumn; column <= lastColumn; column++) {
      line.push(cells[row - 1]?.[column - 1] ?? "");
    }
    rows.push(line);
  }
  return rows;
}

/** Паддинг слоя до размеров листа: webapp опускает пустые хвосты. */
function pad(
  cells: readonly (readonly unknown[])[],
  rows: number,
  cols: number,
): readonly (readonly unknown[])[] {
  const padded: unknown[][] = [];
  for (let row = 0; row < rows; row++) {
    const line: unknown[] = [];
    for (let column = 0; column < cols; column++) {
      line.push(cells[row]?.[column] ?? "");
    }
    padded.push(line);
  }
  return padded;
}
