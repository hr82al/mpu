/**
 * Команда `mpu sheet ls` (`docs/specs/sheet.md`): список листов
 * таблицы в трёх формах.
 *
 * Метаданные кэшируются отдельно от листов и живут своим TTL: список
 * листов меняется реже их содержимого.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { housekeeping, type TabInfo } from "./cache.ts";
import { tabsOf } from "./read.ts";
import type { WebappDeps } from "./webapp.ts";
import { cacheSettings, webappUrl } from "./settings.ts";
import { type SheetIo, targetOf } from "./sources.ts";

const argsSchema = z.object({
  spreadsheet: z.string().optional().describe("цель: URL, ID, алиас, …"),
  long: z.boolean().default(false).describe(
    "подробная строка: размеры, sheetId и индекс",
  ),
  json: z.boolean().default(false).describe("массив объектов JSON"),
  refresh: z.boolean().default(false).describe(
    "не читать кэш метаданных, перечитать и перезаписать",
  ),
});

const resultSchema = z.object({
  tabs: z.array(z.object({
    title: z.string(),
    sheet_id: z.number(),
    rows: z.number(),
    cols: z.number(),
    index: z.number(),
  })).describe("листы таблицы в порядке самой таблицы"),
});

type LsArgs = z.infer<typeof argsSchema>;
type LsResult = z.infer<typeof resultSchema>;

/** Полный порт: к общему срезу добавляется журнал заметок о повторах. */
type LsIo = SheetIo & Pick<CommandIo, "note">;

/** Подстановки для тестов: живого webapp у них нет. */
export interface SheetOptions {
  readonly post?: WebappDeps["post"];
  readonly nowSeconds?: number;
}

/** Ход вызова; `options` — только подстановка канала и часов. */
export async function runLs(
  args: LsArgs,
  io: LsIo,
  options: SheetOptions = {},
): Promise<LsResult> {
  using db = io.openCacheDb();
  const target = await targetOf(io, db, args.spreadsheet);
  const settings = await cacheSettings(io);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  housekeeping(db, settings, nowSeconds);
  const tabs = await tabsOf(
    {
      webapp: { url: webappUrl(io), note: io.note, post: options.post },
      db,
      settings,
      nowSeconds,
    },
    target.ss_id,
    args.refresh,
  );
  return { tabs: [...tabs] };
}

export const sheetLsCommand = defineCommand({
  path: ["sheet", "ls"],
  errorName: "sheet",
  summary: "Показать листы таблицы.",
  usage: "mpu sheet ls [-s SS] [-l] [--json] [-R]",
  help: `По умолчанию печатает по строке на лист — только заголовки, в
порядке самой таблицы.

-l/--long даёт строку вида «Лист\\t1000×26\\tsheetId=0\\tindex=0».
--json печатает массив объектов {title, sheet_id, rows, cols, index}.
Вместе -l и --json не конфликтуют: побеждает --json.

-R/--refresh не читает кэш метаданных и перезаписывает его свежим
ответом; без флага список живёт в кэше два часа.

Цель — -s/--spreadsheet, иначе env MPU_SS, иначе ключ конфигурации
sheet.default (mpu sheet resolve покажет, что выбрано).

Exit: 0 — успех; 2 — ошибки резолва цели; 1 — отказ webapp и
отсутствующий WB_PLUS_WEB_APP_URL.

Примеры: mpu sheet ls -s 4326; mpu sheet ls -s 4326 --json`,
  policy: "ro",
  argsSchema,
  forms: {
    spreadsheet: { short: "s" },
    long: { short: "l" },
    refresh: { short: "R" },
  },
  resultSchema,
  run: (args: LsArgs, io: LsIo) => runLs(args, io),
  render: (result: LsResult, args: LsArgs) => renderTabs(result.tabs, args),
});

/** Три формы вывода; `--json` старше `-l` (спека, снято живьём). */
function renderTabs(tabs: readonly TabInfo[], args: LsArgs): string {
  if (args.json) return `${JSON.stringify(tabs, null, 2)}\n`;
  if (args.long) {
    return tabs
      .map((tab) =>
        `${tab.title}\t${tab.rows}×${tab.cols}\tsheetId=${tab.sheet_id}` +
        `\tindex=${tab.index}\n`
      )
      .join("");
  }
  return tabs.map((tab) => `${tab.title}\n`).join("");
}
