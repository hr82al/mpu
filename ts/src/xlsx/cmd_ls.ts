/** Подкоманда `mpu xlsx ls` — список листов книги. */

import { loadWorkbook, resolvePath, type Subcommand } from "./command.ts";
import { lastValue, parseOptions } from "./cli.ts";
import { renderLeafHelp } from "./help.ts";
import { UsageError } from "./errors.ts";
import { pathNotSetError } from "./resolve.ts";
import { renderLsJson, renderLsLong, renderLsPlain } from "./render.ts";

export const lsCommand: Subcommand = {
  name: "ls",
  help: {
    usage: "mpu xlsx ls [-f PATH] [-l|--long] [--json]",
    summary: "список листов книги",
    body: `Флаги:
  -f, --file PATH  путь или алиас .xlsx; без флага источники по
                   порядку: env MPU_XLSX, config xlsx.default
  -l, --long       колонки: имя, строки×колонки, #индекс (0-based)
      --json       JSON-массив {"title","index","rows","cols"},
                   indent 2, без финального перевода строки
  -l и --json вместе — ошибка (exit 2).

Вывод по умолчанию: имя листа на строку, порядок как в книге.
rows/cols — фактический максимум встреченных ячеек (учитывая merge);
у пустого листа 0×0.

Exit: 0 — успех; 2 — ошибка ввода; 1 — файл не найден / не xlsx.

Пример: mpu xlsx ls -f report.xlsx --json`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
      { long: "file", short: "f", kind: "string" },
      { long: "long", short: "l", kind: "boolean" },
      { long: "json", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(lsCommand.help));
      return 0;
    }
    if (opts.positional.length > 0) {
      throw new UsageError(
        `unexpected argument "${opts.positional[0]}"`,
        { hint: "mpu xlsx ls --help" },
      );
    }
    if (opts.flags.has("long") && opts.flags.has("json")) {
      throw new UsageError("only one of --long / --json can be set");
    }
    const report = await resolvePath(io, lastValue(opts, "file"));
    if (report.resolved === null) throw pathNotSetError();
    const wb = await loadWorkbook(io, report.resolved.path);
    if (opts.flags.has("json")) io.stdout(renderLsJson(wb.sheets));
    else if (opts.flags.has("long")) io.stdout(renderLsLong(wb.sheets));
    else io.stdout(renderLsPlain(wb.sheets));
    return 0;
  },
};
