/** Подкоманда `mpu xlsx resolve` — диагностика резолва пути к книге. */

import { resolvePath, type Subcommand } from "./command.ts";
import { lastValue, parseOptions } from "./cli.ts";
import { renderLeafHelp } from "./help.ts";
import { UsageError } from "./errors.ts";
import { pathNotSetError, type ResolveReport } from "./resolve.ts";

export const resolveCommand: Subcommand = {
  name: "resolve",
  help: {
    usage: "mpu xlsx resolve [-f PATH] [--json]",
    summary: "диагностика резолва пути к книге",
    body: `Показывает три источника пути в порядке приоритета
(--file/-f, env MPU_XLSX, config xlsx.default), их значения и
победителя. Значение-алиас разворачивается в путь алиаса.

Флаги:
  -f, --file PATH  проверить с этим значением флага
      --json       {"resolved": {"path","source"[,"alias"]} | null,
                   "checked": [{"source","label","value","used"} ×3]};
                   exit 0 и при нерезолве

Exit: 0 — успех (или --json всегда); 2 — путь не резолвится без
--json / ошибка ввода.

Пример: mpu xlsx resolve --json`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
      { long: "file", short: "f", kind: "string" },
      { long: "json", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(resolveCommand.help));
      return 0;
    }
    if (opts.positional.length > 0) {
      throw new UsageError(
        `unexpected argument "${opts.positional[0]}"`,
        { hint: "mpu xlsx resolve --help" },
      );
    }
    const report = await resolvePath(io, lastValue(opts, "file"));
    if (opts.flags.has("json")) {
      io.stdout(JSON.stringify(report, null, 2));
      return 0;
    }
    io.stdout(humanReport(report));
    if (report.resolved === null) throw pathNotSetError();
    return 0;
  },
};

function humanReport(report: ResolveReport): string {
  const lines = report.checked.map((source) => {
    const value = source.value ?? "(пусто)";
    const used = source.used ? "  ← используется" : "";
    return `${source.label}: ${value}${used}\n`;
  });
  if (report.resolved !== null) {
    const alias = report.resolved.alias === undefined
      ? ""
      : ` (алиас "${report.resolved.alias}")`;
    lines.push(`путь: ${report.resolved.path}${alias}\n`);
  }
  return lines.join("");
}
