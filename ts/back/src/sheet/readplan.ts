/**
 * План чтения `mpu sheet batch-get` (`docs/specs/sheet-batch.md`,
 * «batch-get»): скрипт из `get`/`read` сливается в один план.
 *
 * Слияние, а не список планов: у команды до двух сетевых вызовов, и
 * десять инструкций `get` обязаны уехать одним `values/batchGet`.
 * Поэтому опции — «последнее слово побеждает», а диапазоны и аспекты
 * накапливаются в порядке появления.
 */

import { UsageError } from "../command/mod.ts";
import { quoteTab } from "./a1.ts";
import { splitScript, tokenize, unquote } from "./script.ts";

/** Что уйдёт в вызовы: значения и/или структура. */
export interface ReadPlan {
  readonly ranges: readonly string[];
  readonly valueRenderOption: string;
  readonly majorDimension: "ROWS" | "COLUMNS";
  readonly dateTimeRenderOption: string;
  /** Аспекты структуры в порядке появления, без дублей. */
  readonly aspects: readonly string[];
  /** Фильтр листов по точному имени; пустой — все листы. */
  readonly sheets: readonly string[];
}

/** Слова `get`, задающие вид значений. */
const RENDER: Readonly<Record<string, string>> = {
  values: "FORMATTED_VALUE",
  formatted: "FORMATTED_VALUE",
  formula: "FORMULA",
  unformatted: "UNFORMATTED_VALUE",
};

/** Слова `get`, задающие направление и формат дат. */
const MAJOR: Readonly<Record<string, "ROWS" | "COLUMNS">> = {
  rows: "ROWS",
  cols: "COLUMNS",
};
const DATES: Readonly<Record<string, string>> = {
  serial: "SERIAL_NUMBER",
  datestr: "FORMATTED_STRING",
};

/** Аспекты структуры, которые webapp отдаёт. */
export const ASPECTS: readonly string[] = [
  "banding",
  "charts",
  "cond",
  "dims",
  "filters",
  "merges",
  "meta",
  "named",
  "props",
  "protected",
];

/**
 * Аспекты уровня ячейки: их webapp не отдаёт вовсе, потому что не
 * запрашивает `gridData`. Отбиваются по имени, а не молча пустым
 * ответом: оператор должен узнать, что спросил недостижимое.
 */
const PER_CELL: readonly string[] = [
  "formats",
  "userformat",
  "note",
  "validation",
  "hyperlink",
  "textruns",
  "everything",
  "value",
  "effective",
  "userentered",
  "formatted",
];

/** Компилирует скрипт чтения в один план. */
export function planRead(source: string, defaultSheet?: string): ReadPlan {
  const ranges: string[] = [];
  const aspects: string[] = [];
  const sheets: string[] = [];
  let valueRenderOption = "FORMATTED_VALUE";
  let majorDimension: "ROWS" | "COLUMNS" = "ROWS";
  let dateTimeRenderOption = "SERIAL_NUMBER";

  for (const instruction of splitScript(source)) {
    const tokens = tokenize(instruction.text);
    const verb = tokens[0];
    if (verb !== "get" && verb !== "read") {
      throw new UsageError(
        `read-глагол должен быть get|read, получено '${verb}'`,
      );
    }
    for (const token of tokens.slice(1)) {
      if (verb === "get") {
        if (RENDER[token] !== undefined) {
          valueRenderOption = RENDER[token];
          continue;
        }
        if (MAJOR[token] !== undefined) {
          majorDimension = MAJOR[token];
          continue;
        }
        if (DATES[token] !== undefined) {
          dateTimeRenderOption = DATES[token];
          continue;
        }
        ranges.push(
          withSheet(unquote(token) === token ? token : token, defaultSheet),
        );
        continue;
      }
      if (PER_CELL.includes(token)) {
        throw new UsageError(
          `аспект '${token}' (per-cell) недоступен: webApp не отдаёт ` +
            `gridData. Доступны: ${ASPECTS.join(", ")}`,
        );
      }
      if (ASPECTS.includes(token)) {
        if (!aspects.includes(token)) aspects.push(token);
        continue;
      }
      sheets.push(unquote(token));
    }
  }

  if (ranges.length === 0 && aspects.length === 0 && sheets.length === 0) {
    throw new UsageError("пустой скрипт чтения");
  }
  return {
    ranges,
    valueRenderOption,
    majorDimension,
    dateTimeRenderOption,
    aspects,
    sheets,
  };
}

/**
 * Диапазон без листа при заданном `-n` префиксуется его именем. Листы
 * при этом не проверяются: у чтения нет метаданных на компиляции, и
 * несуществующий лист назовёт webapp — так решено спекой.
 */
function withSheet(raw: string, defaultSheet?: string): string {
  if (defaultSheet === undefined || raw.includes("!")) return raw;
  // Кавычки ставит `quoteTab` — по тому же правилу, что и всюду в A1:
  // второе правило рядом разошлось бы с первым.
  return `${quoteTab(defaultSheet)}!${raw}`;
}
