/** Подкоманда `mpu xlsx open` — открыть книгу системным приложением. */

import { resolvePath, type Subcommand } from "./command.ts";
import { lastValue, parseOptions } from "./cli.ts";
import { renderLeafHelp } from "./help.ts";
import { FileError, UsageError } from "./errors.ts";
import { pathNotSetError } from "./resolve.ts";

/** Кандидаты-открыватели по порядку попыток. */
const OPENERS = ["xdg-open", "open"] as const;

export const openCommand: Subcommand = {
  name: "open",
  help: {
    usage: "mpu xlsx open [-f PATH] [-p|--print]",
    summary: "открыть книгу в системном приложении",
    body: `Флаги:
  -f, --file PATH  путь или алиас .xlsx; без флага: env MPU_XLSX,
                   затем config xlsx.default
  -p, --print      напечатать резолвленный путь и не открывать

Открыватель (xdg-open, затем open) запускается отвязанным процессом:
результат и существование файла не проверяются. Ни одного открывателя
нет — exit 1 с подсказкой --print.

Exit: 0 — успех; 2 — ошибка ввода/путь не задан; 1 — нет открывателя.

Пример: mpu xlsx open -f report.xlsx --print`,
  },
  run: async (args, io) => {
    const opts = parseOptions(args, [
      { long: "help", short: "h", kind: "boolean" },
      { long: "file", short: "f", kind: "string" },
      { long: "print", short: "p", kind: "boolean" },
    ]);
    if (opts.flags.has("help")) {
      io.stdout(renderLeafHelp(openCommand.help));
      return 0;
    }
    if (opts.positional.length > 0) {
      throw new UsageError(
        `unexpected argument "${opts.positional[0]}"`,
        { hint: "mpu xlsx open --help" },
      );
    }
    const report = await resolvePath(io, lastValue(opts, "file"));
    if (report.resolved === null) throw pathNotSetError();
    if (opts.flags.has("print")) {
      io.stdout(`${report.resolved.path}\n`);
      return 0;
    }
    for (const opener of OPENERS) {
      if (io.launchOpener(opener, report.resolved.path)) return 0;
    }
    throw new FileError(`no opener found (${OPENERS.join(", ")})`, {
      hint: "--print",
    });
  },
};
