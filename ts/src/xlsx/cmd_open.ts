/** Команда `mpu xlsx open` — открыть книгу системным приложением. */

import { z } from "@zod/zod";
import { defineCommand, DomainError } from "../command/mod.ts";
import { resolvePath } from "./settings.ts";
import { pathNotSetError } from "./resolve.ts";

/** Кандидаты-открыватели по порядку попыток. */
const OPENERS = ["xdg-open", "open"] as const;

const argsSchema = z.object({
  file: z.string().optional().describe(
    "путь или алиас .xlsx; без флага источники по порядку: " +
      "env MPU_XLSX, config xlsx.default",
  ),
  print: z.boolean().default(false).describe(
    "напечатать резолвленный путь и не открывать",
  ),
});

const resultSchema = z.object({
  /** Абсолютный путь к книге. */
  path: z.string(),
  /** Открыватель запущен; при `--print` открывать не пытались. */
  launched: z.boolean(),
});

export const openCommand = defineCommand({
  path: ["xlsx", "open"],
  summary: "открыть книгу в системном приложении",
  usage: "mpu xlsx open [-f PATH] [-p|--print]",
  help: `Флаги:
  -f, --file PATH  путь или алиас .xlsx; без флага: env MPU_XLSX,
                   затем config xlsx.default
  -p, --print      напечатать резолвленный путь и не открывать

Открыватель (xdg-open, затем open) запускается отвязанным процессом:
результат и существование файла не проверяются. Ни одного открывателя
нет — exit 1 с подсказкой --print.

Exit: 0 — успех; 2 — ошибка ввода/путь не задан; 1 — нет открывателя.

Пример: mpu xlsx open -f report.xlsx --print`,
  // Мутирующая при любом значении --print: параметр класс команды не
  // меняет (`platform/command-contract.md`, отклонение-fix про --print).
  policy: "rw",
  argsSchema,
  forms: { file: { short: "f" }, print: { short: "p" } },
  resultSchema,
  run: async (args, io) => {
    const report = await resolvePath(io, args.file);
    if (report.resolved === null) throw pathNotSetError();
    const path = report.resolved.path;
    if (args.print) return { path, launched: false };
    for (const opener of OPENERS) {
      if (io.launchOpener(opener, path)) return { path, launched: true };
    }
    throw new DomainError(`no opener found (${OPENERS.join(", ")})`, {
      hint: "--print",
    });
  },
  // Печатать нечего, когда открыватель уже запущен: путь показывает
  // только режим --print, в котором запуска не было.
  render: (result) => result.launched ? "" : `${result.path}\n`,
});
