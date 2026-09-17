/**
 * Команда `mpu sheet open` (`docs/specs/sheet-registry.md`, «Форма
 * ссылки `open`»): открыть таблицу или её лист в браузере.
 *
 * Ссылка и печатается, и передаётся открывателю: печать от запуска не
 * зависит. Из изолированной сессии запуск недостижим, и ссылка —
 * единственный проверяемый результат команды; поэтому её форма
 * сверяется дословно, а сам факт запуска проверяется живьём.
 *
 * С именем листа команда — потребитель кэша метаданных, не хозяин: она
 * спрашивает перечень вкладок, а тот при промахе наполняет ключ
 * `sheet:info:<ss_id>` (`sheet-cache.md`). Удалять и чистить его — не
 * её дело.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import { housekeeping, type TabInfo } from "./cache.ts";
import { tabsOf } from "./read.ts";
import { cacheSettings, webappUrl } from "./settings.ts";
import { type SheetIo, targetOf } from "./sources.ts";
import type { SheetOptions } from "./cmd_ls.ts";

/** Кандидаты-открыватели по порядку попыток (как у `mpu xlsx open`). */
const OPENERS = ["xdg-open", "open"] as const;

/** Базовая форма ссылки; сверяется дословно (спека, отдельный раздел). */
const EDIT_URL = "https://docs.google.com/spreadsheets/d/";

const argsSchema = z.object({
  tab: z.string().optional().describe(
    "имя листа; без него открывается таблица целиком",
  ),
  spreadsheet: z.string().optional().describe("цель: URL, ID, алиас, …"),
});

const resultSchema = z.object({
  url: z.string().describe("ссылка, которую открывают"),
  ss_id: z.string(),
  sheet_id: z.number().nullable().describe(
    "числовой идентификатор листа; null — открывается таблица целиком",
  ),
  launched: z.boolean().describe("открыватель запущен"),
});

type OpenArgs = z.infer<typeof argsSchema>;
type OpenResult = z.infer<typeof resultSchema>;

type OpenIo = SheetIo & Pick<CommandIo, "note" | "launchOpener">;

/** Ссылка на таблицу либо на её лист — обе формы из спеки. */
export function sheetUrl(ssId: string, sheetId: number | null): string {
  const base = `${EDIT_URL}${ssId}/edit`;
  return sheetId === null ? base : `${base}#gid=${sheetId}`;
}

/**
 * Лист по имени; его нет — отказ с перечнем доступных. Сравнение
 * точное: листы «Отчёт» и «отчёт» в одной таблице живут спокойно, и
 * угадывать за оператора, какой из них он звал, нельзя.
 */
function sheetIdOf(tabs: readonly TabInfo[], title: string): number {
  const found = tabs.find((tab) => tab.title === title);
  if (found !== undefined) return found.sheet_id;
  throw new UsageError(
    [
      `листа '${title}' в таблице нет; есть:`,
      ...tabs.map((tab) => `  ${tab.title}`),
    ].join("\n"),
  );
}

export async function runOpen(
  args: OpenArgs,
  io: OpenIo,
  options: SheetOptions = {},
): Promise<OpenResult> {
  using db = io.openCacheDb();
  const target = targetOf(db, args.spreadsheet);
  const sheetId = args.tab === undefined
    ? null
    : sheetIdOf(await openTabs(io, db, target.ss_id, options), args.tab);
  const url = sheetUrl(target.ss_id, sheetId);
  return {
    url,
    ss_id: target.ss_id,
    sheet_id: sheetId,
    launched: launch(io, url),
  };
}

/** Метаданные листов: тот же путь, которым ходит `mpu sheet ls`. */
function openTabs(
  io: OpenIo,
  db: CacheDb,
  ssId: string,
  options: SheetOptions,
): Promise<readonly TabInfo[]> {
  const settings = cacheSettings(io, db);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Housekeeping зовётся только здесь: без имени листа команда к кэшу
  // не притрагивается вовсе, а он удаляет протухшее — «открыть
  // таблицу» не повод менять состояние.
  housekeeping(db, settings, nowSeconds);
  return tabsOf(
    {
      webapp: { url: webappUrl(io), note: io.note, post: options.post },
      db,
      settings,
      nowSeconds,
    },
    ssId,
    false,
  );
}

/** Запуск отвязанным процессом; ни одного открывателя нет — `false`. */
function launch(io: OpenIo, url: string): boolean {
  for (const opener of OPENERS) {
    if (io.launchOpener(opener, url)) return true;
  }
  io.note(`открывателя нет (${OPENERS.join(", ")}); ссылка напечатана`);
  return false;
}

export const sheetOpenCommand = defineCommand({
  path: ["sheet", "open"],
  errorName: "sheet open",
  summary: "Открыть таблицу или её лист в браузере.",
  usage: "mpu sheet open [ЛИСТ] [-s SS]",
  help: `Печатает ссылку и передаёт её открывателю (xdg-open, затем
open). Печать от запуска не зависит: ссылка нужна и тогда, когда
открывать нечем — на сервере без графики, в пайпе, в логе.

Без ЛИСТ открывается таблица целиком, и кэш метаданных при этом не
трогается. С ЛИСТ спрашивается перечень вкладок — он и даёт числовой
gid ссылки; ответ кладётся в кэш метаданных на общих правилах.

Цель — -s/--spreadsheet, иначе ключ конфигурации sheet.default.

Exit: 0 — успех; 1 — открывателя не нашлось (ссылка при этом
напечатана) либо сервер метаданных недоступен; 2 — ошибки резолва цели
и отсутствующий лист (с перечнем доступных).

Примеры: mpu sheet open -s otchet; mpu sheet open 'Сводка' -s otchet`,
  // Мутирующая: запуск открывателя — действие наружу, а с именем листа
  // команда ещё и наполняет кэш метаданных.
  policy: "rw",
  argsSchema,
  forms: {
    tab: { positional: "one" },
    spreadsheet: { short: "s" },
  },
  resultSchema,
  run: (args: OpenArgs, io: OpenIo) => runOpen(args, io),
  render: (result: OpenResult) => `${result.url}\n`,
  // Ссылка напечатана, но открыть её было нечем — это неуспех, и код
  // обязан его назвать. Печать при этом остаётся: она и есть то, что
  // спасает вызов (`sheet-registry.md`, «Форма ссылки»).
  textExitCode: (result: OpenResult) => result.launched ? 0 : 1,
});
