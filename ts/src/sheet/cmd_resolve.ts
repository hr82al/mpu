/**
 * Команда `mpu sheet resolve` (`docs/specs/sheet.md`): диагностика
 * резолва цели без сети.
 *
 * Ходить в webapp ей незачем: вопрос «какая таблица имеется в виду»
 * решается кэш-БД и настройками, и ответ на него нужен раньше, чем
 * первый запрос наружу.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { housekeeping } from "./cache.ts";
import { cacheSettings } from "./settings.ts";
import { type SheetIo, targetOf } from "./sources.ts";

const argsSchema = z.object({
  spreadsheet: z.string().optional().describe(
    "цель: URL, ID, алиас, client_id или подстрока заголовка",
  ),
});

const resultSchema = z.object({
  ss_id: z.string().describe("идентификатор таблицы"),
  source: z.string().describe("источник значения: flag | env | config"),
  kind: z.string().describe("чем оказалось значение"),
  original_input: z.string().describe("исходная строка источника"),
});

type ResolveResult = z.infer<typeof resultSchema>;

export const sheetResolveCommand = defineCommand({
  path: ["sheet", "resolve"],
  errorName: "sheet",
  summary: "Показать, в какую таблицу разрешается цель.",
  usage: "mpu sheet resolve [-s SS]",
  help: `Печатает JSON: ss_id, источник значения (flag | env | config),
вид значения (url | id | alias | client_id | title_fuzzy) и исходную
строку. В сеть не ходит вовсе — только кэш-БД и настройки.

Цель берётся из первого непустого источника: -s/--spreadsheet, затем
env MPU_SS, затем ключ конфигурации sheet.default. Источники не
смешиваются: победивший разбирается целиком.

Значение разбирается по порядку: ссылка docs.google.com → ID → алиас
(mpu sheet alias) → client_id (только цифры) → подстрока заголовка.
Несколько совпадений — отказ со списком кандидатов, exit 2.

Exit: 0 — цель разрешена; 2 — цель не задана, не найдена или
неоднозначна.

Примеры: mpu sheet resolve -s 4326; mpu sheet resolve -s 'Отчёт WB'`,
  policy: "ro",
  argsSchema,
  forms: { spreadsheet: { short: "s" } },
  resultSchema,
  run: async (args, io: SheetIo): Promise<ResolveResult> => {
    using db = io.openCacheDb();
    // Housekeeping идёт перед каждой подкомандой семейства, включая
    // эту: кэш чистится по времени, а не по тому, кто его читает
    // (`platform/webapp-http.md`).
    housekeeping(db, await cacheSettings(io), Math.floor(Date.now() / 1000));
    return await targetOf(io, db, args.spreadsheet);
  },
  render: (result: ResolveResult) => `${JSON.stringify(result, null, 2)}\n`,
});
