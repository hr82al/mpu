/** Команда `mpu xlsx get` — значения диапазонов книги. */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { loadWorkbook } from "./book.ts";
import { resolvePath } from "./settings.ts";
import { pathNotSetError } from "./resolve.ts";
import {
  type AreaRef,
  cellName,
  parseRangeToken,
  prefixRangeToken,
  resolveArea,
} from "./range.ts";
import { cellKey, findSheet, type Workbook } from "./workbook.ts";
import { type OutputCell, renderGetRaw, renderGetTsv } from "./render.ts";

const RANGES_HINT = "mpu xlsx get [RANGES...] [--from FILE] [--sheet SHEET]";

const argsSchema = z.object({
  ranges: z.array(z.string()).default([]).describe(
    "диапазоны вида 'Лист!A1:C3', открытые 'Лист!A:A', голое имя листа",
  ),
  file: z.string().optional().describe(
    "путь или алиас .xlsx; без флага: env MPU_XLSX, config xlsx.default",
  ),
  sheet: z.string().optional().describe(
    "префиксует диапазоны без «!»; без диапазонов — весь лист",
  ),
  from: z.array(z.string()).default([]).describe(
    "файл с диапазонами построчно; повторяем; «-» — stdin",
  ),
  render: z.enum(["both", "values", "formulas"], {
    error: (issue) => `invalid --render value "${String(issue.input)}"`,
  }).default("both").describe("что попадает в ячейку результата"),
  raw: z.boolean().default(false).describe("голые значения без шапки"),
  tsv: z.boolean().default(false).describe("таблица с шапкой range/value"),
}).refine((args) => !(args.raw && args.tsv), {
  error: "only one of --raw / --tsv can be set",
});

const cellSchema = z.object({
  range: z.string(),
  /** Отсутствует в режиме `--render formulas`. */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  /** Есть ⇔ у ячейки есть формула; в режиме `values` не выводится. */
  formula: z.string().optional(),
});

const resultSchema = z.object({
  /** Абсолютный путь книги, из которой прочитаны ячейки. */
  file: z.string(),
  cells: z.array(cellSchema),
});

export const getCommand = defineCommand({
  path: ["xlsx", "get"],
  summary: "значения диапазонов книги",
  usage: "mpu xlsx get [RANGES...] [-f PATH] [-n|--sheet NAME] " +
    "[--from FILE|-] [--render both|values|formulas] [--raw|--tsv]",
  help: `Диапазоны: 'Лист!A1', 'Лист!A1:C3', открытые 'Лист!A:A',
'Лист!1:5', 'Лист!A5:A' (клэмп к данным; заданная граница не
уменьшается), голое имя листа — весь лист. Имя с пробелом/'/! — в
одинарных кавычках, кавычка внутри удваивается.

Источники складываются: аргументы + --from (файл построчно, «-» —
stdin; строка с # — комментарий, пустые пропускаются). Дубликаты
убираются, порядок первого вхождения сохраняется.

Флаги:
  -f, --file PATH    путь или алиас .xlsx; иначе env MPU_XLSX, затем
                     config xlsx.default
  -n, --sheet NAME   префикс диапазонов без «!»; без них — весь лист
      --from FILE|-  файл с диапазонами; повторяем; «-» — stdin
      --render MODE  both (по умолчанию) | values | formulas
      --raw | --tsv  форма вывода, не больше одной (exit 2)

Вывод по умолчанию — JSON (indent 2, без финального \\n): file и
cells[{range, value, formula}]; formula только у реальных формул,
пустые ячейки включены (value null). --tsv: шапка range/value/formula,
экранирование \\ \\n \\r \\t, bool → True/False, null — пусто. --raw:
одна ячейка — голое значение без \\n; несколько — строка на ячейку.

Exit: 0 — успех (пустой результат не ошибка); 2 — ошибка ввода;
1 — файл не найден / не xlsx / лист не найден.

Примеры:
  mpu xlsx get 'Данные!A1:C3' -f report.xlsx
  mpu xlsx get A1:C3 --sheet Данные --tsv`,
  policy: "ro",
  argsSchema,
  forms: {
    ranges: { positional: "rest" },
    file: { short: "f" },
    sheet: { short: "n" },
  },
  resultSchema,
  run: async (args, io) => {
    // Диапазоны разбираются до открытия книги (инвариант спеки), потому
    // сначала весь ввод, и только потом путь и файл.
    const fromTokens = await fromFileTokens(args.from, io);
    const tokens = dedupe(
      prefixAll([...args.ranges, ...fromTokens], args.sheet),
    );
    const targets = bindTargets(tokens, args.sheet);
    const report = await resolvePath(io, args.file);
    if (report.resolved === null) throw pathNotSetError();
    const workbook = await loadWorkbook(io, report.resolved.path);
    return {
      file: report.resolved.path,
      cells: collectCells(workbook, targets).map((cell) =>
        project(cell, args.render)
      ),
    };
  },
  render: (result, args) => {
    if (args.raw) return renderGetRaw(result.cells, args.render);
    if (args.tsv) return renderGetTsv(result.cells, args.render);
    // Форма по умолчанию — сам результат как JSON (контракт спеки).
    return JSON.stringify(result, null, 2);
  },
});

/** Оставляет в ячейке то, что просит `--render`; порядок ключей — спеки. */
function project(cell: OutputCell, mode: RenderChoice): OutputCell {
  switch (mode) {
    case "values":
      return { range: cell.range, value: cell.value };
    case "formulas":
      return cell.formula === undefined
        ? { range: cell.range }
        : { range: cell.range, formula: cell.formula };
    case "both":
      return cell.formula === undefined
        ? { range: cell.range, value: cell.value }
        : { range: cell.range, value: cell.value, formula: cell.formula };
    default:
      return unreachable(mode);
  }
}

function unreachable(mode: never): never {
  throw new TypeError(`неизвестный режим --render: ${String(mode)}`);
}

type RenderChoice = z.infer<typeof argsSchema>["render"];

/** Диапазоны из файлов `--from`: построчно, `#` — комментарий. */
async function fromFileTokens(
  files: readonly string[],
  io: CommandIo,
): Promise<string[]> {
  const tokens: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = file === "-"
        ? await io.readTextStdin()
        : await io.readTextFile(file);
    } catch (err) {
      if (err instanceof NotFoundIoError) {
        throw new DomainError(`ranges file not found: "${file}"`, {
          cause: err,
        });
      }
      throw new DomainError(`cannot read ranges file "${file}"`, {
        cause: err,
      });
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
  workbook: Workbook,
  targets: readonly BoundTarget[],
): OutputCell[] {
  const cells: OutputCell[] = [];
  for (const target of targets) {
    const sheet = findSheet(workbook, target.sheet);
    if (sheet === undefined) {
      const titles = workbook.sheets.map((s) => s.title).join(", ");
      throw new DomainError(
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
