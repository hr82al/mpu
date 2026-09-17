/**
 * Команды `mpu sheet cache info` и `mpu sheet cache clear`
 * (`docs/specs/sheet-cache.md`): состояние локального кэша вкладок и
 * его очистка.
 *
 * Эта пара — хозяин кэша; `get`, `ls` и `open` его только потребляют.
 * Отсюда и разделение обязанностей: потребители наполняют кэш по ходу
 * своей работы, а чистит и показывает его тот, для кого это и есть
 * работа.
 *
 * Housekeeping здесь не зовётся ни одной из двух, и это осознанно:
 * атом требует его «перед каждой командой семейства»
 * (`platform/webapp-http.md`), но он **удаляет** протухшие записи, а
 * `info` обязана состояние не менять. Более узкая и поздняя спека
 * побеждает — то же решение, что у `batch-get`.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { cacheReady, cacheState, dropInfo, dropTabs } from "./cache.ts";
import { targetOf } from "./sources.ts";

const infoArgs = z.object({});

const infoResult = z.object({
  ready: z.boolean().describe("таблицы кэша существуют"),
  tabs: z.number().describe("всего вкладок в кэше"),
  bytes: z.number().describe("суммарный размер тел вкладок"),
  spreadsheets: z.array(z.object({
    ss_id: z.string(),
    tabs: z.number(),
    bytes: z.number(),
    latest: z.number(),
  })).describe("разбивка по таблицам, от крупных к мелким"),
});

type InfoResult = z.infer<typeof infoResult>;

const clearArgs = z.object({
  spreadsheet: z.string().optional().describe(
    "цель: URL, ID, алиас, …; без неё чистится весь кэш",
  ),
});

const clearResult = z.object({
  ready: z.boolean().describe("таблицы кэша существуют"),
  spreadsheetId: z.string().nullable().describe(
    "таблица, чей кэш чистили; null — весь кэш",
  ),
  tabs: z.number().describe("удалённых вкладок"),
  info: z.number().describe("удалённых ключей метаданных"),
});

type ClearArgs = z.infer<typeof clearArgs>;
type ClearResult = z.infer<typeof clearResult>;

/**
 * Килобайты для человека; байты остаются в структурном результате.
 * Непустой кэш никогда не печатается нулём: округление вниз выдало бы
 * полкилобайта вкладок за «ничего нет», а ноль в этом выводе обязан
 * значить ровно ноль байт.
 */
function kb(bytes: number): number {
  if (bytes === 0) return 0;
  return Math.max(1, Math.round(bytes / 1024));
}

export function renderCacheInfo(result: InfoResult): string {
  if (!result.ready) {
    return "кэша нет: таблицы не заведены; попробуй: mpu init\n";
  }
  const head = `total: ${result.tabs} tabs, ${kb(result.bytes)} KB\n`;
  return head + result.spreadsheets
    .map((entry) =>
      `  ${entry.ss_id}  tabs=${entry.tabs}  size=${kb(entry.bytes)}KB` +
      `  latest=${entry.latest}\n`
    )
    .join("");
}

/**
 * Три исхода, различимые по строке. Число вкладок печатается всегда,
 * включая ноль, а метаданные названы отдельно: вкладок бывает сотня, а
 * ключ метаданных один, и сумма смешала бы разнородное
 * (`sheet-cache.md`, инвариант 1).
 */
export function renderCacheClear(result: ClearResult): string {
  if (!result.ready) {
    return "кэша нет: таблицы не заведены; попробуй: mpu init\n";
  }
  // Число, а не слово, и одно и то же в обоих режимах: без `-s` ключей
  // бывает много, и «dropped» скрыло бы величину, которая уже снята с
  // работы. Форма вывода не должна зависеть от того, как позвали.
  const metadata = result.info > 0
    ? `metadata dropped: ${result.info}`
    : "no metadata";
  // Область названа вслух: без `-s` снимается кэш всех таблиц сразу, и
  // отличить этот исход от точечного оператор обязан по самой строке, а
  // не по памяти о том, как он позвал.
  const scope = result.spreadsheetId === null
    ? " (весь кэш)"
    : ` (${result.spreadsheetId})`;
  return `cleared ${result.tabs} tabs${scope}; ${metadata}\n`;
}

export const sheetCacheInfoCommand = defineCommand({
  path: ["sheet", "cache", "info"],
  errorName: "sheet cache info",
  summary: "Показать состояние локального кэша вкладок.",
  usage: "mpu sheet cache info",
  help: `Печатает итог и разбивку по таблицам, от крупных к мелким:
размер тел вкладок и момент самой свежей записи.

Состояние только читается: команда «покажи состояние», молча его
меняющая, сделала бы недостоверной любую следующую сверку. Протухшие
записи она поэтому и не убирает — это дело чтения и mpu sheet cache
clear.

Пустой кэш — строка итога с нулями. Таблиц кэша нет вовсе — команда
говорит об этом и советует mpu init; ошибкой это не является.

Exit: 0 — успех.`,
  policy: "ro",
  argsSchema: infoArgs,
  resultSchema: infoResult,
  run: (_args, io) => {
    using db = io.openCacheDb();
    if (!cacheReady(db)) {
      return Promise.resolve({
        ready: false,
        tabs: 0,
        bytes: 0,
        spreadsheets: [],
      });
    }
    const state = cacheState(db);
    return Promise.resolve({
      ready: true,
      tabs: state.reduce((sum, entry) => sum + entry.tabs, 0),
      bytes: state.reduce((sum, entry) => sum + entry.bytes, 0),
      spreadsheets: state.map((entry) => ({ ...entry })),
    });
  },
  render: renderCacheInfo,
});

export const sheetCacheClearCommand = defineCommand({
  path: ["sheet", "cache", "clear"],
  errorName: "sheet cache clear",
  summary: "Очистить локальный кэш вкладок.",
  usage: "mpu sheet cache clear [-s SS]",
  help: `Удаляет две вещи: тела вкладок и метаданные таблицы. С -s —
по одной таблице, без -s — весь кэш.

Вывод различает три исхода: чистить было нечего; удалены вкладки;
вкладок не было, но метаданные сброшены. Одним числом это не
выражается — вкладок бывает сотня, а ключ метаданных один, — поэтому
число печатается для вкладок всегда, включая ноль, а про метаданные
сказано отдельно.

Таблиц кэша нет вовсе — команда говорит об этом и завершается успехом.

Exit: 0 — успех; 2 — цель не резолвится.

Пример: mpu sheet cache clear -s 4326`,
  policy: "rw",
  argsSchema: clearArgs,
  forms: { spreadsheet: { short: "s" } },
  resultSchema: clearResult,
  run: (args: ClearArgs, io) => {
    using db = io.openCacheDb();
    if (!cacheReady(db)) {
      return Promise.resolve({
        ready: false,
        spreadsheetId: null,
        tabs: 0,
        info: 0,
      });
    }
    // Резолв цели — до всякого удаления: неразобранная цель не должна
    // стоить кэша.
    const ssId = args.spreadsheet === undefined
      ? undefined
      : targetOf(db, args.spreadsheet).ss_id;
    return Promise.resolve({
      ready: true,
      spreadsheetId: ssId ?? null,
      // Обе величины сняты с результата своего же удаления, а не с
      // числа найденного до него (`ts/CLAUDE.md`, «Величина берётся
      // там, где совершается работа»).
      tabs: dropTabs(db, ssId),
      info: dropInfo(db, ssId),
    });
  },
  render: renderCacheClear,
});
