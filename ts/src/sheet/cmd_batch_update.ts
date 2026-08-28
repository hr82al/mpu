/**
 * Команда `mpu sheet batch-update` (`docs/specs/sheet-batch.md`):
 * скрипт мини-языка компилируется целиком и уходит одним вызовом.
 *
 * Порядок шагов — контракт, а не удобство: метаданные снимаются до
 * компиляции (имена листов резолвятся по текущему состоянию таблицы),
 * компиляция целиком предшествует отправке (частично применённого
 * скрипта не бывает), а кэш инвалидируется только после успеха.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { type BatchIo, scriptOf } from "./batch_io.ts";
import { housekeeping, invalidateTabs } from "./cache.ts";
import { compileScript } from "./compile.ts";
import { printJson } from "./emit.ts";
import type { SheetRef } from "./grid.ts";
import { tabsOf } from "./read.ts";
import { cacheSettings, webappUrl } from "./settings.ts";
import { targetOf } from "./sources.ts";
import { callWebapp } from "./webapp.ts";

const argsSchema = z.object({
  expression: z.array(z.string()).default([]).describe(
    "инструкция скрипта; флаг повторяем, части склеиваются",
  ),
  from: z.string().optional().describe("файл со скриптом; '-' — весь stdin"),
  spreadsheet: z.string().optional().describe("цель: URL, ID, алиас, …"),
  sheet: z.string().optional().describe(
    "лист по умолчанию для диапазонов без '!'",
  ),
  literal: z.boolean().default(false).describe(
    "значения всегда строки: ни чисел, ни формул, ни булевых",
  ),
  "dry-run": z.boolean().default(false).describe(
    "напечатать запросы и не отправлять их",
  ),
});

const resultSchema = z.object({
  spreadsheetId: z.string().describe("идентификатор таблицы"),
  requests: z.array(z.unknown()).describe(
    "скомпилированные запросы по порядку",
  ),
  dryRun: z.boolean().describe("вызов был печатью, отправки не было"),
  // `null`, а не отсутствие ключа: результат обязан пережить
  // сериализацию без потерь (контракт команды, инвариант 6), а
  // `undefined` из JSON исчезает молча.
  reply: z.unknown().describe("ответ webapp; у печати и пустого скрипта null"),
});

type UpdateArgs = z.infer<typeof argsSchema>;
type UpdateResult = z.infer<typeof resultSchema>;

/** Подстановки канала и часов; в CLI не задаются. */
export interface BatchOptions {
  readonly post?: (
    url: string,
    body: string,
  ) => Promise<{ readonly status: number; readonly text: string }>;
  readonly nowSeconds?: number;
}

export async function runBatchUpdate(
  args: UpdateArgs,
  io: BatchIo,
  options: BatchOptions = {},
): Promise<UpdateResult> {
  const script = await scriptOf(io, {
    expressions: args.expression,
    from: args.from,
  });
  using db = io.openCacheDb();
  const target = targetOf(db, args.spreadsheet);
  const settings = cacheSettings(io, db);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  housekeeping(db, settings, nowSeconds);
  const webapp = { url: webappUrl(io), note: io.note, post: options.post };
  // `refresh: true` — метаданные обязаны быть свежими: по ним резолвятся
  // имена листов, и вчерашний кэш отправил бы запрос не туда.
  const tabs = await tabsOf(
    { webapp, db, settings, nowSeconds },
    target.ss_id,
    true,
  );
  const sheets: readonly SheetRef[] = tabs.map((tab) => ({
    title: tab.title,
    sheetId: tab.sheet_id,
  }));
  const compiled = compileScript(script, {
    sheets,
    defaultSheet: args.sheet,
    literal: args.literal,
  });

  const head = {
    spreadsheetId: target.ss_id,
    requests: [...compiled.requests],
    dryRun: args["dry-run"],
  };
  // Пустая компиляция не отправляется и без `--dry-run`: посылать
  // пустой batchUpdate незачем, а печатать «нет операций» — честно.
  if (compiled.requests.length === 0 || args["dry-run"]) {
    return { ...head, reply: null };
  }
  const reply = await callWebapp(webapp, "spreadsheets/batchUpdate", {
    ssId: target.ss_id,
    requestBody: { requests: compiled.requests },
  });
  const titles = compiled.sheetIds
    .map((id) => sheets.find((sheet) => sheet.sheetId === id)?.title)
    .filter((title): title is string => title !== undefined);
  invalidateTabs(db, target.ss_id, titles);
  return { ...head, reply };
}

/** Печать: «нет операций», запросы печати либо ответ сервера как есть. */
export function renderBatchUpdate(result: UpdateResult): string {
  if (result.requests.length === 0) return "нет операций\n";
  if (result.dryRun) return printJson({ requests: result.requests });
  return printJson(result.reply);
}

export const sheetBatchUpdateCommand = defineCommand({
  path: ["sheet", "batch-update"],
  errorName: "sheet batch-update",
  summary: "Пакетная правка Google-таблицы мини-языком.",
  usage:
    "mpu sheet batch-update [-e ВЫРАЖЕНИЕ]… [--from FILE|-] [-s SS] [-n TAB] [--dry-run] [-l]",
  help: `Скрипт компилируется целиком и уходит одним вызовом
spreadsheets/batchUpdate: применяются либо все инструкции, либо ни одна.

Скрипт — все -e плюс содержимое --from (файл, '-' — весь stdin);
источники складываются. Нет ни -e, ни --from и stdin не терминал —
скрипт читается из stdin. Инструкции разделяются переводом строки или
';' вне скобок и кавычек; '#' на границе токена — комментарий до конца
строки. -n/--sheet задаёт лист для диапазонов без 'Лист!'.

Глаголы: set label note style clear merge unmerge border sort dedupe
trim validate protect unprotect autofill copy cut find-replace freeze,
семейства cols/rows (insert delete move autosize resize hide show),
group/ungroup, append, sheet (add delete rename dup tab), cond
(add clear), name (add del), плюс @kind {json} и raw {json}.

Лист, создаваемый этим же скриптом, на компиляции не существует.

--dry-run печатает {"requests": […]} и молчит в сеть (метаданные всё
равно читаются: без них не собрать sheetId). -l/--literal делает все
значения строками. Скрипт из одних комментариев печатает «нет
операций».

Exit: 0 — успех; 2 — ошибки скрипта, ввода и резолва цели; 1 — отказ
webapp и отсутствующий WB_PLUS_WEB_APP_URL.

Пример: mpu sheet batch-update -s 4326 -n Отчёт \
  -e "cols insert H +1; label H1 'Итого' bold"`,
  policy: "rw",
  argsSchema,
  forms: {
    expression: { short: "e" },
    spreadsheet: { short: "s" },
    sheet: { short: "n" },
    literal: { short: "l" },
  },
  resultSchema,
  run: (args: UpdateArgs, io: CommandIo) => runBatchUpdate(args, io),
  render: renderBatchUpdate,
});
