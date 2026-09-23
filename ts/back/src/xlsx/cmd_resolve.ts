/** Команда `mpu xlsx resolve` — диагностика резолва пути к книге. */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { resolvePath } from "./settings.ts";

const argsSchema = z.object({
  file: z.string().optional().describe("проверить с этим значением флага"),
});

const sourceSchema = z.enum(["flag", "env", "config"]);

const resultSchema = z.object({
  /** Победивший источник и готовый путь; ни один не дал пути — null. */
  resolved: z.object({
    path: z.string(),
    source: sourceSchema,
    /** Имя алиаса, через который пришёл путь; прямой путь — без ключа. */
    alias: z.string().optional(),
  }).nullable(),
  /** Все три источника по порядку приоритета. */
  checked: z.array(z.object({
    source: sourceSchema,
    label: z.string(),
    /** Сырое значение источника; пустое или незаданное — null. */
    value: z.string().nullable(),
    used: z.boolean(),
  })),
});

export const resolveCommand = defineCommand({
  path: ["xlsx", "resolve"],
  keys: {},
  summary: "диагностика резолва пути к книге",
  usage: "mpu xlsx resolve [file: FILE]",
  help: `Звать, когда непонятно, какую книгу xlsx возьмут команды без
file:. Показывает три источника пути в порядке приоритета
(file:, MPU_XLSX (env-файл), config xlsx.default), их значения и
победителя. Значение-алиас разворачивается в путь алиаса.

Структурный результат отдаётся всегда, в том числе когда путь не
резолвится; код завершения в этом случае 2 — и с форматом, и без.

Exit: 0 — путь резолвится; 2 — не резолвится или ошибка ввода.`,
  examples: [
    "mpu xlsx resolve file: report.xlsx",
  ],
  policy: "ro",
  argsSchema,
  forms: { file: { short: "f" } },
  resultSchema,
  run: async (args, io) => await resolvePath(io, args.file),
  render: (result) => {
    const lines = result.checked.map((source) => {
      const value = source.value ?? "(пусто)";
      const used = source.used ? "  ← используется" : "";
      return `${source.label}: ${value}${used}\n`;
    });
    if (result.resolved !== null) {
      const alias = result.resolved.alias === undefined
        ? ""
        : ` (алиас "${result.resolved.alias}")`;
      lines.push(`путь: ${result.resolved.path}${alias}\n`);
    }
    return lines.join("");
  },
  // Диагностика печатается и при неуспехе, но код завершения сообщает
  // вызывающему, что пути нет (контракт спеки xlsx.md).
  textExitCode: (result) => result.resolved === null ? 2 : 0,
});
