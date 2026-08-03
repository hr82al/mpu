/** Команда `mpu xlsx ls` — список листов книги. */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { loadWorkbook } from "./book.ts";
import { resolvePath } from "./settings.ts";
import { pathNotSetError } from "./resolve.ts";
import { renderLsLong, renderLsPlain } from "./render.ts";

const argsSchema = z.object({
  file: z.string().optional().describe(
    "путь или алиас .xlsx; без флага источники по порядку: " +
      "env MPU_XLSX, config xlsx.default",
  ),
  long: z.boolean().default(false).describe(
    "колонки: имя, строки×колонки, #индекс (0-based)",
  ),
});

const resultSchema = z.object({
  sheets: z.array(z.object({
    title: z.string(),
    /** Порядковый номер листа в книге, 0-based. */
    index: z.number().int(),
    rows: z.number().int(),
    cols: z.number().int(),
  })),
});

export const lsCommand = defineCommand({
  path: ["xlsx", "ls"],
  summary: "список листов книги",
  usage: "mpu xlsx ls [-f PATH] [-l|--long]",
  help: `Флаги:
  -f, --file PATH  путь или алиас .xlsx; без флага источники по
                   порядку: env MPU_XLSX, config xlsx.default
  -l, --long       колонки: имя, строки×колонки, #индекс (0-based)

Вывод по умолчанию: имя листа на строку, порядок как в книге.
rows/cols — фактический максимум встреченных ячеек (учитывая merge);
у пустого листа 0×0.

Exit: 0 — успех; 2 — ошибка ввода; 1 — файл не найден / не xlsx.

Пример: mpu xlsx ls -f report.xlsx --long`,
  policy: "ro",
  argsSchema,
  forms: { file: { short: "f" }, long: { short: "l" } },
  resultSchema,
  run: async (args, io) => {
    const report = await resolvePath(io, args.file);
    if (report.resolved === null) throw pathNotSetError();
    const workbook = await loadWorkbook(io, report.resolved.path);
    return {
      sheets: workbook.sheets.map((sheet) => ({
        title: sheet.title,
        index: sheet.index,
        rows: sheet.rows,
        cols: sheet.cols,
      })),
    };
  },
  render: (result, args) =>
    args.long ? renderLsLong(result.sheets) : renderLsPlain(result.sheets),
});
