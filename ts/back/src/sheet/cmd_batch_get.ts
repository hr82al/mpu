/**
 * Команда `mpu sheet batch-get` (`docs/specs/sheet-batch.md`):
 * значения диапазонов и структура листов одним планом.
 *
 * Кэш не читается и не пишется: `batch-get` зовут, когда нужно
 * сегодняшнее состояние таблицы, а не вчерашнее — иначе для этого есть
 * `mpu sheet get`. По той же причине листы на компиляции не
 * проверяются: метаданных для проверки взять неоткуда, а спрашивать их
 * ради проверки значило бы лишний вызов на каждое чтение.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { type BatchIo, scriptOf } from "./batch_io.ts";
import type { BatchOptions } from "./cmd_batch_update.ts";
import { printJson } from "./emit.ts";
import { planRead, type ReadPlan } from "./readplan.ts";
import { webappUrl } from "./settings.ts";
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
  "dry-run": z.boolean().default(false).describe(
    "напечатать поля вызовов и не делать их",
  ),
});

const resultSchema = z.object({
  spreadsheetId: z.string().describe("идентификатор таблицы"),
  dryRun: z.boolean().describe("вызов был печатью, сети не было"),
  // Оба ключа — `null`, когда вызова не было: отсутствие ключа не
  // пережило бы сериализацию результата (инвариант 6 контракта).
  values: z.unknown().describe("поля вызова values/batchGet либо его ответ"),
  meta: z.unknown().describe("аспекты структуры либо собранная выборка"),
});

type GetArgs = z.infer<typeof argsSchema>;
type GetResult = z.infer<typeof resultSchema>;

/** Аспект → пути ответа `spreadsheets/get`, которые он забирает. */
const ASPECT_PATHS: Readonly<Record<string, readonly string[]>> = {
  merges: ["merges"],
  cond: ["conditionalFormats"],
  protected: ["protectedRanges"],
  charts: ["charts"],
  banding: ["bandedRanges"],
  filters: ["basicFilter", "filterViews"],
  props: ["properties"],
  meta: ["developerMetadata"],
  dims: ["rowGroups", "columnGroups"],
};

export async function runBatchGet(
  args: GetArgs,
  io: BatchIo,
  options: BatchOptions = {},
): Promise<GetResult> {
  const script = await scriptOf(io, {
    expressions: args.expression,
    from: args.from,
  });
  const plan = planRead(script, args.sheet);
  using db = io.openCacheDb();
  const target = targetOf(db, args.spreadsheet);
  const head = { spreadsheetId: target.ss_id, dryRun: args["dry-run"] };
  if (args["dry-run"]) {
    // Оба ключа присутствуют всегда: `null` говорит «этого вызова не
    // будет» отчётливее, чем отсутствующий ключ.
    return {
      ...head,
      values: plan.ranges.length === 0 ? null : valuesCall(target.ss_id, plan),
      meta: metaPlan(plan),
    };
  }

  const webapp = { url: webappUrl(io), note: io.note, post: options.post };
  const values = plan.ranges.length === 0 ? null : await callWebapp(
    webapp,
    "spreadsheets/values/batchGet",
    valuesCall(target.ss_id, plan),
  );
  const meta = metaPlan(plan) === null ? null : metaOf(
    await callWebapp(webapp, "spreadsheets/get", { ssId: target.ss_id }),
    plan,
  );
  return { ...head, values, meta };
}

/** Поля вызова `values/batchGet` — они же тело печати `--dry-run`. */
function valuesCall(
  ssId: string,
  plan: ReadPlan,
): Readonly<Record<string, unknown>> {
  return {
    ssId,
    ranges: plan.ranges,
    majorDimension: plan.majorDimension,
    valueRenderOption: plan.valueRenderOption,
    dateTimeRenderOption: plan.dateTimeRenderOption,
  };
}

/** Что печатать в `meta` при `--dry-run`; нечего читать — `null`. */
function metaPlan(plan: ReadPlan): Readonly<Record<string, unknown>> | null {
  if (plan.aspects.length === 0 && plan.sheets.length === 0) return null;
  return { aspects: plan.aspects, sheets: plan.sheets };
}

/**
 * Выборка из ответа `spreadsheets/get` по аспектам плана. Путь
 * копируется, только если он есть в ответе: отсутствующий раздел — не
 * пустой, о нём просто нечего сказать.
 */
function metaOf(
  reply: Readonly<Record<string, unknown>>,
  plan: ReadPlan,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (plan.aspects.includes("named") && reply.namedRanges !== undefined) {
    out.namedRanges = reply.namedRanges;
  }
  const paths = plan.aspects.flatMap((aspect) => ASPECT_PATHS[aspect] ?? []);
  if (paths.length === 0 && plan.sheets.length === 0) return out;
  const sheets: Record<string, unknown>[] = [];
  for (const raw of Array.isArray(reply.sheets) ? reply.sheets : []) {
    const sheet = raw as Record<string, unknown>;
    const properties = sheet.properties as Record<string, unknown> | undefined;
    const title = String(properties?.title ?? "");
    // Пустой фильтр значит «все листы»: перечислять их все руками —
    // работа, которую оператор не должен делать.
    if (plan.sheets.length > 0 && !plan.sheets.includes(title)) continue;
    const picked: Record<string, unknown> = { title };
    for (const path of paths) {
      if (sheet[path] !== undefined) picked[path] = sheet[path];
    }
    sheets.push(picked);
  }
  out.sheets = sheets;
  return out;
}

/** Печать: ключи есть ровно тогда, когда соответствующий вызов был. */
export function renderBatchGet(result: GetResult): string {
  if (result.dryRun) {
    return printJson({ values: result.values, meta: result.meta });
  }
  const out: Record<string, unknown> = { spreadsheetId: result.spreadsheetId };
  const values = result.values as Record<string, unknown> | null;
  if (values?.valueRanges !== undefined) out.valueRanges = values.valueRanges;
  if (result.meta !== null) out.meta = result.meta;
  return printJson(out);
}

export const sheetBatchGetCommand = defineCommand({
  path: ["sheet", "batch-get"],
  errorName: "sheet batch-get",
  summary: "Прочитать значения и структуру Google-таблицы одним планом.",
  usage:
    "mpu sheet batch-get [-e ВЫРАЖЕНИЕ]… [--from FILE|-] [-s SS] [-n TAB] [--dry-run]",
  help: `Скрипт из инструкций get и read сливается в один план: все
диапазоны уходят одним values/batchGet, все аспекты структуры — одним
spreadsheets/get. Опции — «последнее слово побеждает».

get [RANGE|СЛОВО]… — значения. Слова: values/formatted (по умолчанию),
formula, unformatted — вид значений; rows/cols — направение; serial (по
умолчанию) / datestr — формат дат.

read [АСПЕКТ|ЛИСТ]… — структура. Аспекты: banding charts cond dims
filters merges meta named props protected; прочий токен — имя листа,
по которому фильтруется выборка (без имён — все листы). Аспекты уровня
ячейки (formats, note, validation, …) недоступны: webApp не отдаёт
gridData.

Листы и диапазоны на компиляции не проверяются — ошибку назовёт
webapp. Кэш листов не читается и не пишется: повторный вызов всегда
идёт в сеть.

--dry-run печатает {"values": …|null, "meta": …|null} и не делает ни
одного вызова.

Exit: 0 — успех; 2 — ошибки скрипта, ввода и резолва цели; 1 — отказ
webapp и отсутствующий WB_PLUS_WEB_APP_URL.

Пример: mpu sheet batch-get -s 4326 -n Sheet1 \\
  -e "get A1:B2 formula; read Sheet1 merges props"`,
  policy: "ro",
  argsSchema,
  forms: {
    expression: { short: "e" },
    spreadsheet: { short: "s" },
    sheet: { short: "n" },
  },
  resultSchema,
  run: (args: GetArgs, io: CommandIo) => runBatchGet(args, io),
  render: renderBatchGet,
});
