/**
 * Команда `mpu sheet get` (`docs/specs/sheet.md`): значения диапазонов
 * в JSON, raw или TSV.
 *
 * Всё, что решается до сети, решается до неё: пустой набор диапазонов,
 * незнакомый `--render`, диапазон без листа и отсутствующий файл
 * `--from` отбиваются раньше обращения к БД и webapp.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  UsageError,
  VerbatimUsageError,
} from "../command/mod.ts";
import { NoTabError, parseRange, type Range } from "./a1.ts";
import { housekeeping } from "./cache.ts";
import { type Layer, readRanges } from "./read.ts";
import { cacheSettings, webappUrl } from "./settings.ts";
import type { SheetOptions } from "./cmd_ls.ts";
import { rangeStrings, type SheetIo, targetOf } from "./sources.ts";

/** Значения `--render` и слои, которые каждое означает. */
const RENDERS: Readonly<Record<string, readonly Layer[]>> = {
  both: ["values", "formulas"],
  values: ["values"],
  formulas: ["formulas"],
  formatted: ["formatted"],
};

const USAGE_NO_RANGES =
  "Usage: mpu sheet get [RANGES...] [--from FILE] [--sheet TAB]";

const argsSchema = z.object({
  ranges: z.array(z.string()).default([]).describe(
    "диапазоны A1; складываются с --from",
  ),
  spreadsheet: z.string().optional().describe("цель: URL, ID, алиас, …"),
  sheet: z.string().optional().describe(
    "лист по умолчанию для диапазонов без '!'",
  ),
  from: z.string().optional().describe(
    "файл со списком диапазонов; '-' — весь stdin",
  ),
  render: z.string().default("both").describe(
    "слои: both | values | formulas | formatted",
  ),
  raw: z.boolean().default(false).describe("один слой без JSON-обвязки"),
  tsv: z.boolean().default(false).describe(
    "то же, но диапазоны разделены пустой строкой",
  ),
  refresh: z.boolean().default(false).describe(
    "не читать кэш, перечитать из webapp и перезаписать",
  ),
});

const resultSchema = z.object({
  spreadsheetId: z.string().describe("идентификатор таблицы"),
  valueRanges: z.array(z.object({
    range: z.string(),
    values: z.array(z.array(z.unknown())).optional(),
    formulas: z.array(z.array(z.unknown())).optional(),
    formatted: z.array(z.array(z.unknown())).optional(),
    fromCache: z.boolean(),
  })).describe("прочитанные диапазоны в порядке ввода"),
});

type GetArgs = z.infer<typeof argsSchema>;
type GetResult = z.infer<typeof resultSchema>;

type GetIo = SheetIo & Pick<CommandIo, "note">;

/** Ход вызова; `options` — только подстановка канала и часов. */
export async function runGet(
  args: GetArgs,
  io: GetIo,
  options: SheetOptions = {},
): Promise<GetResult> {
  const layers = RENDERS[args.render];
  if (layers === undefined) {
    throw new UsageError(
      "--render must be one of: both, values, formulas, formatted",
    );
  }
  const ranges = parseRanges(
    await rangeStrings(io, args.ranges, args.from),
    args.sheet,
  );
  using db = io.openCacheDb();
  const target = targetOf(db, args.spreadsheet);
  const settings = cacheSettings(io, db);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  housekeeping(db, settings, nowSeconds);
  const results = await readRanges(
    {
      webapp: { url: webappUrl(io), note: io.note, post: options.post },
      db,
      settings,
      nowSeconds,
    },
    target.ss_id,
    ranges,
    { layers, refresh: args.refresh },
  );
  // Копия в изменяемую форму: схема результата описывает данные, а не
  // источник, и `readonly` из чтения в неё не переносится.
  return {
    spreadsheetId: target.ss_id,
    valueRanges: results.map((range) => ({
      range: range.range,
      ...(range.values === undefined
        ? {}
        : { values: range.values.map((row) => [...row]) }),
      ...(range.formulas === undefined
        ? {}
        : { formulas: range.formulas.map((row) => [...row]) }),
      ...(range.formatted === undefined
        ? {}
        : { formatted: range.formatted.map((row) => [...row]) }),
      fromCache: range.fromCache,
    })),
  };
}

export const sheetGetCommand = defineCommand({
  path: ["sheet", "get"],
  errorName: "sheet",
  summary: "Прочитать диапазоны Google-таблицы.",
  usage:
    "mpu sheet get [RANGES...] [-s SS] [-n TAB] [--from FILE] [--render R] [--raw|--tsv] [-R]",
  help: `Читает диапазоны A1 через Apps Script webapp с кэшом целых
листов: повторный вызов того же диапазона отвечает из кэша и помечает
это полем "fromCache": true.

Диапазоны берутся из аргументов и из --from (файл построчно, '-' —
stdin; пустые строки и строки с # пропускаются) — источники
складываются. -n/--sheet TAB префиксует диапазоны без '!' и, если
диапазонов нет вовсе, означает «весь лист TAB».

--render both (по умолчанию) даёт значения и формулы, values и formulas
— по одному слою, formatted — отформатированные строки локали таблицы
(всегда мимо кэша). Ключ слоя есть в JSON ровно тогда, когда слой
запрошен.

--raw печатает один слой (values → formulas → formatted) ячейками через
табуляцию; единственная строка единственного диапазона идёт без
финального перевода строки. --tsv — то же, но диапазоны разделены
пустой строкой и перевод строки в конце есть всегда. Вместе они не
конфликтуют: побеждает --tsv.

-R/--refresh не читает кэш листов и метаданных, но перезаписывает его.

Exit: 0 — успех; 2 — ошибки ввода и резолва цели; 1 — отказ webapp,
отсутствующий WB_PLUS_WEB_APP_URL и ненайденный лист.

Примеры: mpu sheet get 'Sheet1!A1:B2' -s 4326;
mpu sheet get -n Отчёт --tsv -s 4326`,
  policy: "ro",
  argsSchema,
  forms: {
    ranges: { positional: "rest" },
    spreadsheet: { short: "s" },
    sheet: { short: "n" },
    refresh: { short: "R" },
  },
  resultSchema,
  run: (args: GetArgs, io: GetIo) => runGet(args, io),
  render: (result: GetResult, args: GetArgs) => renderGet(result, args),
});

/**
 * Строки диапазонов в разобранный вид. Пустой набор — отказ формой
 * использования: спрашивать «что читать» у пустого ввода бессмысленно.
 */
function parseRanges(
  raw: readonly string[],
  tab: string | undefined,
): readonly Range[] {
  if (raw.length === 0) {
    // Дословно, без префикса команды: у формы использования своя
    // строка, и голден канала снят именно с неё.
    if (tab === undefined) throw new VerbatimUsageError(USAGE_NO_RANGES);
    // `--sheet` без диапазонов означает лист целиком: так его и читают.
    return [{ tab }];
  }
  return raw.map((item) => {
    const range = parseRange(item);
    if (range.tab !== undefined) return range;
    if (tab === undefined) throw new NoTabError(item);
    return { tab, span: range.span };
  });
}

/** Три формы вывода; `--tsv` старше `--raw` (спека, снято живьём). */
function renderGet(result: GetResult, args: GetArgs): string {
  if (args.tsv) return tsvText(result.valueRanges);
  if (args.raw) return rawText(result.valueRanges);
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Слой для плоских форм: values → formulas → formatted. */
function layerOf(range: GetResult["valueRanges"][number]): unknown[][] {
  const layer = range.values ?? range.formulas ?? range.formatted ?? [];
  return layer.map((row) => [...row]);
}

/** Строки диапазона: ячейки через табуляцию. */
function linesOf(range: GetResult["valueRanges"][number]): readonly string[] {
  return layerOf(range).map((row) => row.map(cellText).join("\t"));
}

/**
 * Текст ячейки: пустая — пустая строка, bool — `True`/`False`
 * (единообразие с `mpu xlsx`, отклонение `preserve`).
 */
function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "boolean") return cell ? "True" : "False";
  return String(cell);
}

/**
 * `--raw`: единственная строка единственного диапазона без табуляции
 * печатается без финального перевода — её и вставляют в другую команду.
 */
function rawText(ranges: GetResult["valueRanges"]): string {
  const lines = ranges.flatMap((range) => linesOf(range));
  const single = ranges.length === 1 && lines.length === 1 &&
    !lines[0].includes("\t");
  return single ? lines[0] : `${lines.join("\n")}\n`;
}

/** `--tsv`: диапазоны разделены пустой строкой, перевод в конце всегда. */
function tsvText(ranges: GetResult["valueRanges"]): string {
  return `${ranges.map((range) => linesOf(range).join("\n")).join("\n\n")}\n`;
}
