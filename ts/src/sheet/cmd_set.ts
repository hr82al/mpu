/**
 * Команда `mpu sheet set` (`docs/specs/sheet-set.md`): запись значений
 * через `values/batchUpdate`.
 *
 * Порядок шагов — контракт, а не удобство: весь ввод разбирается до
 * сети, диапазоны — тоже (неразбираемый отбивается ДО записи, иначе
 * запись прошла бы, а кэш вкладки остался старым, инвариант 4), и
 * только потом уходят запросы. Инвалидация — после успеха, но по тому,
 * что записано: если второй запрос упал после первого, вкладки
 * первого всё равно устарели.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import { formatRange, parseRange, type Range } from "./a1.ts";
import { housekeeping, invalidateTabs } from "./cache.ts";
import { printJson } from "./emit.ts";
import { tabsOf } from "./read.ts";
import { cacheSettings, webappUrl } from "./settings.ts";
import { targetOf } from "./sources.ts";
import { callWebapp, type WebappDeps } from "./webapp.ts";
import {
  setInput,
  type SetIo,
  type SetItem,
  type SetKind,
} from "./set_input.ts";

/**
 * Открытый одностолбцовый диапазон: `B2:B`. Заливка по нему идёт до
 * последней занятой строки столбца, а не до конца листа, и стоит
 * лишнего запроса чтения (спека, «Побочные эффекты»).
 */
const OPEN_COLUMN = /^([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})$/;

/** Как тип ввода превращается в параметр API. */
const INPUT_OPTION: Readonly<Record<SetKind, string>> = {
  formula: "USER_ENTERED",
  value: "RAW",
};

/**
 * Порядок групп фиксирован, а не берётся из порядка ввода: сообщение
 * о частичном успехе обязано быть предсказуемым — оператор читает его
 * в тот момент, когда меньше всего готов гадать.
 */
const ORDER: readonly SetKind[] = ["formula", "value"];

const argsSchema = z.object({
  range: z.string().optional().describe(
    "A1-диапазон записи; в JSON-режиме — ЦЕЛЬ, а не диапазон",
  ),
  value: z.string().optional().describe("значение одной ячейки"),
  from: z.string().optional().describe(
    "пакет: файл 'диапазон<TAB>значение'; '-' — весь stdin",
  ),
  spreadsheet: z.string().optional().describe("цель: URL, ID, алиас, …"),
  literal: z.boolean().default(false).describe(
    "значение записать как есть (RAW); JSON-режима не касается",
  ),
});

const groupSchema = z.object({
  valueInputOption: z.string(),
  updatedCells: z.number().describe("ячеек по ответу сервера"),
  updatedRanges: z.number().describe("диапазонов по ответу сервера"),
});

const resultSchema = z.object({
  spreadsheetId: z.string(),
  updatedCells: z.number().describe("всего ячеек по ответам сервера"),
  updatedRanges: z.number().describe("всего диапазонов по ответам сервера"),
  // Массив всегда, даже когда запрос один: форма вывода не зависит от
  // того, смешал ли оператор типы ввода (инвариант 2).
  groups: z.array(groupSchema).describe("по группе на отправленный запрос"),
});

type SetCmdArgs = z.infer<typeof argsSchema>;
type SetResult = z.infer<typeof resultSchema>;
type Group = z.infer<typeof groupSchema>;

/** Подстановки канала и часов; в CLI не задаются. */
export interface SetOptions {
  readonly post?: WebappDeps["post"];
  readonly nowSeconds?: number;
}

type SetCmdIo = SetIo & Pick<CommandIo, "note">;

/** Данные одного запроса записи. */
interface Entry {
  readonly range: string;
  readonly values: readonly (readonly unknown[])[];
}

export async function runSet(
  args: SetCmdArgs,
  io: SetCmdIo,
  options: SetOptions = {},
): Promise<SetResult> {
  const input = await setInput(io, args);
  if (input.target !== undefined && args.spreadsheet !== undefined) {
    // Цель названа дважды. Молчаливое старшинство одного источника
    // здесь хуже отказа: оба названы явно, и выбрать за оператора
    // значит записать не в ту таблицу.
    throw new UsageError(
      `цель названа дважды: '${input.target}' позиционным и ` +
        `'${args.spreadsheet}' через -s`,
    );
  }
  using db = io.openCacheDb();
  const target = targetOf(db, args.spreadsheet ?? input.target);
  // Диапазоны разбираются целиком и до сети: негодный отбивается, а не
  // пропускается молча (инвариант 4).
  const ranges = input.items.map((item) => parseRange(item.range));
  const settings = cacheSettings(io, db);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  housekeeping(db, settings, nowSeconds);
  const webapp = { url: webappUrl(io), note: io.note, post: options.post };
  const deps = { webapp, db, settings, nowSeconds };

  const entries: Entry[] = [];
  for (let at = 0; at < input.items.length; at++) {
    entries.push(
      input.mode === "json"
        ? await expand(deps, target.ss_id, input.items[at], ranges[at])
        : { range: input.items[at].range, values: [[input.items[at].value]] },
    );
  }
  const titles = await tabTitles(deps, target.ss_id, ranges);

  const groups: Group[] = [];
  for (const kind of ORDER) {
    const picked = entries.filter((_, at) => input.items[at].kind === kind);
    if (picked.length === 0) continue;
    try {
      groups.push(await write(webapp, target.ss_id, kind, picked));
    } catch (err) {
      // Часть значений уже записана — сказать об этом обязательно:
      // молчаливый код 1 после частичной записи оставил бы оператора с
      // таблицей, о состоянии которой он знает только «не получилось»
      // (инвариант 1).
      if (groups.length > 0) {
        invalidateTabs(db, target.ss_id, titles);
        throw new DomainError(
          `записано частично: ${describe(groups)} уже в таблице, ` +
            `${INPUT_OPTION[kind]} не записаны — ${reason(err)}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  invalidateTabs(db, target.ss_id, titles);
  return {
    spreadsheetId: target.ss_id,
    updatedCells: groups.reduce((sum, group) => sum + group.updatedCells, 0),
    updatedRanges: groups.reduce((sum, group) => sum + group.updatedRanges, 0),
    groups,
  };
}

/** Один запрос записи; величины снимаются с ответа, а не с ввода. */
async function write(
  webapp: WebappDeps,
  ssId: string,
  kind: SetKind,
  entries: readonly Entry[],
): Promise<Group> {
  const reply = await callWebapp(webapp, "spreadsheets/values/batchUpdate", {
    ssId,
    requestBody: {
      valueInputOption: INPUT_OPTION[kind],
      data: entries.map((entry) => ({
        range: entry.range,
        values: entry.values,
      })),
    },
  });
  // Сервер записывает не всегда столько, сколько просили: заливка
  // раскрывается, пустые строки схлопываются (инвариант 3).
  const responses = reply.responses;
  return {
    valueInputOption: INPUT_OPTION[kind],
    updatedCells: numberOf(reply.totalUpdatedCells),
    updatedRanges: Array.isArray(responses) ? responses.length : 0,
  };
}

/**
 * Раскрытие открытого столбца: `B2:B` превращается в заливку до
 * последней занятой строки. Столбец читается прямо сейчас и мимо кэша
 * — вчерашняя граница залила бы не туда.
 */
async function expand(
  deps: Parameters<typeof tabsOf>[0],
  ssId: string,
  item: SetItem,
  range: Range,
): Promise<Entry> {
  const open = range.span === undefined ? null : OPEN_COLUMN.exec(range.span);
  if (open === null || open[1].toUpperCase() !== open[3].toUpperCase()) {
    return { range: item.range, values: [[item.value]] };
  }
  const column = open[1];
  const from = Number(open[2]);
  const whole = formatRange({ tab: range.tab, span: `${column}:${column}` });
  const reply = await callWebapp(
    deps.webapp,
    "spreadsheets/values/batchGet",
    {
      ssId,
      ranges: [whole],
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    },
  );
  const last = lastRow(reply);
  // Ниже последней занятой строки заливать нечего: пустой столбец и
  // строка выше границы дают одну ячейку, а не тысячу.
  const to = Math.max(last, from);
  return {
    range: formatRange({
      tab: range.tab,
      span: `${column}${from}:${column}${to}`,
    }),
    values: Array.from({ length: to - from + 1 }, () => [item.value]),
  };
}

/** Последняя занятая строка столбца по ответу чтения. */
function lastRow(reply: Readonly<Record<string, unknown>>): number {
  const ranges = reply.valueRanges;
  if (!Array.isArray(ranges) || ranges.length === 0) return 0;
  const values = (ranges[0] as Readonly<Record<string, unknown>>).values;
  return Array.isArray(values) ? values.length : 0;
}

/**
 * Имена вкладок для инвалидации. Диапазон без имени листа означает
 * первый лист таблицы — его название спрашивается у метаданных: без
 * него запись прошла бы, а кэш вкладки остался старым.
 */
async function tabTitles(
  deps: Parameters<typeof tabsOf>[0],
  ssId: string,
  ranges: readonly Range[],
): Promise<readonly string[]> {
  const named = ranges
    .map((range) => range.tab)
    .filter((tab): tab is string => tab !== undefined);
  if (named.length === ranges.length) return [...new Set(named)];
  const tabs = await tabsOf(deps, ssId, false);
  const first = tabs.find((tab) => tab.index === 0) ?? tabs[0];
  return [...new Set(first === undefined ? named : [...named, first.title])];
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Что уже в таблице — по группам и их собственным величинам. */
function describe(groups: readonly Group[]): string {
  return groups
    .map((group) => `${group.valueInputOption} (${group.updatedCells} ячеек)`)
    .join(", ");
}

/** Форма вывода одна всегда: объект, и в нём массив групп. */
export function renderSet(result: SetResult): string {
  return printJson(result);
}

export const sheetSetCommand = defineCommand({
  path: ["sheet", "set"],
  errorName: "sheet set",
  summary: "Записать значения в Google-таблицу.",
  usage: "mpu sheet set [ДИАПАЗОН ЗНАЧЕНИЕ | --from FILE | ЦЕЛЬ] [-s SS] [-l]",
  help: `Режим выбирает форма вызова, а не флаг:

  mpu sheet set 'Лист!A1' '=SUM(B:B)' -s ЦЕЛЬ   одна ячейка
  mpu sheet set --from пакет.tsv -s ЦЕЛЬ         пакет из файла
  … | mpu sheet set [ЦЕЛЬ]                       JSON из потока

ВНИМАНИЕ: первый позиционный означает разное. В первых двух режимах
это ДИАПАЗОН, в JSON-режиме — ЦЕЛЬ: диапазоны там в самом JSON. Цель,
названная и позиционным, и через -s, — ошибка ввода.

Пакет: 'диапазон<TAB>значение' на строку; пустые и с '#' пропускаются.
Строка без табуляции — ошибка с номером; пустой пакет — тоже.

JSON: [{"range": …, "formula"|"value": …}, …]. Тип задаёт имя
свойства: 'formula' сервер разбирает как ввод пользователя, 'value'
пишет как есть. Поэтому -l/--literal JSON-режима не касается: он
задаёт умолчание двух других.

Разные типы уходят двумя запросами, и операция НЕ атомарна: второй
может упасть после первого. Тогда код 1, и сообщение называет
записанное.

В JSON-режиме открытый столбец ('B2:B') заливается до последней
занятой строки, и ради неё делается ЛИШНИЙ запрос чтения: режим
дороже прочих. Записанные вкладки инвалидируются в кэше.

Exit: 0 — успех; 1 — отказ webapp; 2 — ошибки ввода и резолва цели.

Пример: mpu sheet set 'Свод!B2' 42 -s otchet`,
  policy: "rw",
  argsSchema,
  forms: {
    range: { positional: "one" },
    value: { positional: "one" },
    spreadsheet: { short: "s" },
    literal: { short: "l" },
  },
  resultSchema,
  run: (args: SetCmdArgs, io: SetCmdIo) => runSet(args, io),
  render: renderSet,
});
