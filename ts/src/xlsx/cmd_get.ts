/** Подкоманда `mpu xlsx get` — значения диапазонов книги. */

import {
  loadWorkbook,
  resolvePath,
  type Subcommand,
  type XlsxIo,
} from "./command.ts";
import { lastValue, parseOptions } from "./cli.ts";
import { renderLeafHelp } from "./help.ts";
import { FileError, NotFoundIoError, UsageError } from "./errors.ts";
import { pathNotSetError } from "./resolve.ts";
import {
  type AreaRef,
  cellName,
  parseRangeToken,
  prefixRangeToken,
  resolveArea,
} from "./range.ts";
import { cellKey, findSheet, type Workbook } from "./workbook.ts";
import {
  type OutputCell,
  type RenderMode,
  renderGetJson,
  renderGetRaw,
  renderGetTsv,
} from "./render.ts";

const RANGES_HINT = "mpu xlsx get [RANGES...] [--from FILE] [--sheet SHEET]";

export const getCommand: Subcommand = {
  name: "get",
  help: {
    usage: "mpu xlsx get [RANGES...] [-f PATH] [-n|--sheet NAME] " +
      "[--from FILE|-] [--render both|values|formulas] " +
      "[--json|--raw|--tsv]",
    summary: "значения диапазонов книги",
    body: `Диапазоны: 'Лист!A1', 'Лист!A1:C3', открытые 'Лист!A:A',
'Лист!1:5', 'Лист!A5:A' (клэмп к данным листа; заданная граница не
уменьшается), голое имя листа — весь лист. Имя с пробелом/'/! берётся
в одинарные кавычки, кавычка внутри удваивается.

Источники диапазонов складываются: аргументы + --from (файл построчно,
«-» — stdin; строка с # — комментарий, пустые пропускаются). Дубликаты
по строковому виду убираются, порядок первого вхождения сохраняется.

Флаги:
  -f, --file PATH    путь или алиас .xlsx; без флага: env MPU_XLSX,
                     затем config xlsx.default
  -n, --sheet NAME   префиксует диапазоны без «!»; без диапазонов —
                     весь лист NAME
      --from FILE|-  файл с диапазонами; повторяем; «-» — stdin
      --render MODE  both (по умолчанию) | values | formulas
      --json | --raw | --tsv — форма вывода, не больше одной (exit 2)

Вывод по умолчанию (JSON, indent 2, без финального \\n):
{"file": "<абс. путь>", "cells": [{"range": "Лист!A1", "value": ...,
"formula": "=..."}]}. Ключ "formula" только у реальных формул. Пустые
ячейки диапазона включены (value null). --tsv: шапка
range/value/formula, экранирование \\ \\n \\r \\t, bool → True/False,
null — пусто. --raw: одна ячейка — голое значение без \\n; несколько —
строка на ячейку без шапки и range.

Exit: 0 — успех (пустой результат — не ошибка); 2 — ошибки ввода;
1 — файл не найден / не xlsx / лист не найден.

Примеры:
  mpu xlsx get 'Данные!A1:C3' -f report.xlsx
  mpu xlsx get A1:C3 --sheet Данные --tsv`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
      { long: "file", short: "f", kind: "string" },
      { long: "sheet", short: "n", kind: "string" },
      { long: "from", kind: "string" },
      { long: "render", kind: "string" },
      { long: "json", kind: "boolean" },
      { long: "raw", kind: "boolean" },
      { long: "tsv", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(getCommand.help));
      return 0;
    }
    const outputs = ["json", "raw", "tsv"].filter((f) => opts.flags.has(f));
    if (outputs.length > 1) {
      throw new UsageError("only one of --json / --raw / --tsv can be set");
    }
    const mode = renderMode(lastValue(opts, "render"));
    const sheetFlag = lastValue(opts, "sheet");
    const fromTokens = await fromFileTokens(opts.values.get("from"), io);
    const tokens = dedupe(
      prefixAll([...opts.positional, ...fromTokens], sheetFlag),
    );
    const targets = bindTargets(tokens, sheetFlag);
    const report = await resolvePath(io, lastValue(opts, "file"));
    if (report.resolved === null) throw pathNotSetError();
    const wb = await loadWorkbook(io, report.resolved.path);
    const cells = collectCells(wb, targets);
    const output = opts.flags.has("raw")
      ? renderGetRaw(cells, mode)
      : opts.flags.has("tsv")
      ? renderGetTsv(cells, mode)
      : renderGetJson(report.resolved.path, cells, mode);
    io.stdout(output);
    return 0;
  },
};

function renderMode(value: string | undefined): RenderMode {
  if (value === undefined || value === "both") return "both";
  if (value === "values" || value === "formulas") return value;
  throw new UsageError(`invalid --render value "${value}"`, {
    hint: "both | values | formulas",
  });
}

/** Диапазоны из файлов `--from`: построчно, `#` — комментарий. */
async function fromFileTokens(
  files: readonly string[] | undefined,
  io: XlsxIo,
): Promise<string[]> {
  const tokens: string[] = [];
  for (const file of files ?? []) {
    let text: string;
    try {
      text = file === "-"
        ? await io.readTextStdin()
        : await io.readTextFile(file);
    } catch (err) {
      if (err instanceof NotFoundIoError) {
        throw new FileError(`ranges file not found: "${file}"`, { cause: err });
      }
      throw new FileError(`cannot read ranges file "${file}"`, { cause: err });
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      tokens.push(trimmed);
    }
  }
  return tokens;
}

function prefixAll(
  tokens: readonly string[],
  sheetFlag: string | undefined,
): readonly string[] {
  if (sheetFlag === undefined) return tokens;
  return tokens.map((token) => prefixRangeToken(token, sheetFlag));
}

function dedupe(tokens: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

interface BoundTarget {
  readonly sheet: string;
  readonly area: AreaRef;
}

/** Разбирает токены; диапазон без листа — ошибка с подсказкой. */
function bindTargets(
  tokens: readonly string[],
  sheetFlag: string | undefined,
): readonly BoundTarget[] {
  if (tokens.length === 0) {
    if (sheetFlag !== undefined) return [{ sheet: sheetFlag, area: {} }];
    throw new UsageError("no ranges provided", { hint: RANGES_HINT });
  }
  return tokens.map((token) => {
    const target = parseRangeToken(token);
    if (target.kind === "wholeSheet") {
      return { sheet: target.sheet, area: {} };
    }
    if (target.sheet === undefined) {
      throw new UsageError(`range "${token}" has no sheet name`, {
        hint: `--sheet <имя листа> или форма Лист!${token}`,
      });
    }
    return { sheet: target.sheet, area: target.area };
  });
}

/** Плотный прямоугольник каждого диапазона, порядок построчный. */
function collectCells(
  wb: Workbook,
  targets: readonly BoundTarget[],
): OutputCell[] {
  const cells: OutputCell[] = [];
  for (const target of targets) {
    const sheet = findSheet(wb, target.sheet);
    if (sheet === undefined) {
      const titles = wb.sheets.map((s) => s.title).join(", ");
      throw new FileError(
        `sheet "${target.sheet}" not found. Available: ${titles}`,
      );
    }
    const span = resolveArea(target.area, sheet.rows, sheet.cols);
    if (span === null) continue;
    for (let row = span.startRow; row <= span.endRow; row++) {
      for (let col = span.startCol; col <= span.endCol; col++) {
        const cell = sheet.cells.get(cellKey(col, row));
        const range = `${sheet.title}!${cellName(col, row)}`;
        cells.push(
          cell?.formula === undefined
            ? { range, value: cell?.value ?? null }
            : { range, value: cell.value, formula: cell.formula },
        );
      }
    }
  }
  return cells;
}
