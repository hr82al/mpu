/**
 * Шесть команд `mpu api wb-loader-*` (`docs/specs/api-wb-loader.md`):
 * блокировки фермы, состояние загрузчика, снятие блокировки, чтение и
 * правка конфигурации, форс-прогон и сброс состояния.
 *
 * Общее у всех: цель резолвится до sid (`wb_loader.ts`), имя загрузчика
 * приходит в одной из двух форм и проверяется по закрытому списку **до
 * сети**, а `--print` печатает эквивалентный вызов и не делает ничего.
 *
 * Взаимоисключающие флаги проверяются там же, до сети: «последний
 * выигрывает» у пары `--enable/--disable` означало бы включить
 * загрузчик там, где просили выключить.
 */

import { z } from "@zod/zod";
import {
  type Command,
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import type { CacheReader } from "../selector/mod.ts";
import { openSlback, type SlbackSession } from "../slback/mod.ts";
import { asDomainError } from "./command.ts";
import {
  cacheTarget,
  type Call,
  curlSnippet,
  directTarget,
  loaderPath,
  type LoaderTarget,
  requireLoader,
  requireReason,
  requireSlug,
  stateFromDate,
} from "./wb_loader.ts";

const FIND_PATH = "/admin/wb-loader/blocked-loaders/v1/find";
const RESUME_PATH = "/admin/wb-loader/blocked-loaders/v1/resume";

/** Подстановки для тестов: живого sl-back у них нет. */
export interface LoaderOptions {
  readonly session?: SlbackSession;
}

type LoaderIo = CommandIo;

const selector = z.string({ error: "нужен СЕЛЕКТОР" })
  .describe("селектор: sid, client_id, таблица, заголовок");

const targetForms = {
  selector: { positional: "one" },
  loader: { positional: "one" },
  print: { short: "p" },
} as const;

const callResult = z.object({
  sid: z.string(),
  call: z.object({
    method: z.string(),
    path: z.string(),
    body: z.unknown(),
  }).describe("запрос, который команда делает или напечатала"),
  printed: z.boolean().describe("вызов только напечатан"),
  response: z.unknown().describe("ответ сервера; у печати — null"),
});

type CallResult = z.infer<typeof callResult>;

/** Цель вызова: прямой режим либо резолв по кэшу. */
function targetOf(
  io: LoaderIo,
  input: { selector: string; sid?: string; clientId?: string },
): LoaderTarget {
  const direct = directTarget(input);
  if (direct !== undefined) return direct;
  // Кэш открывается только там, где он нужен: прямой режим работает и
  // при недоступном кэше (`api-wb-cards-reset.md`, тот же инвариант).
  using db = io.openCacheDb();
  const cache: CacheReader = {
    query: (sql, ...params) => db.query(sql, ...params),
  };
  return cacheTarget(cache, io.envFile, input);
}

/** Исполнение запроса либо печать; общее для всех шести команд. */
async function perform(
  io: LoaderIo,
  options: LoaderOptions,
  sid: string,
  call: Call,
  print: boolean,
): Promise<CallResult> {
  const head = {
    sid,
    call: { ...call, body: call.body ?? null },
    printed: print,
  };
  if (print) return { ...head, response: null };
  const session = options.session ?? openSlback(io);
  try {
    return {
      ...head,
      response: await session.call(call.method, call.path, call.body),
    };
  } catch (err) {
    throw asDomainError(err);
  }
}

/** Печать: curl-сниппет либо ответ сервера как есть. */
function renderCall(result: CallResult, extra: readonly string[] = []): string {
  if (result.printed) {
    return curlSnippet(
      {
        method: result.call.method,
        path: result.call.path,
        body: result.call.body ?? undefined,
      },
      extra,
    );
  }
  return `${JSON.stringify(result.response, null, 2)}\n`;
}

const blockedArgs = z.object({
  loader: z.string().optional().describe("фильтр по загрузчику (camelCase)"),
  reason: z.string().optional().describe("фильтр по причине блокировки"),
  "only-permanent": z.boolean().default(false).describe(
    "только причины, требующие ручного снятия",
  ),
  sid: z.string().optional().describe("фильтр по кабинету"),
  server: z.string().optional().describe(
    "клиентский постфильтр по инстансу (wb-N); в тело запроса не идёт",
  ),
  print: z.boolean().default(false).describe("напечатать вызов и выйти"),
});

type BlockedArgs = z.infer<typeof blockedArgs>;

/** Фильтр `blocked`: только заданное; пустой объект — вся ферма. */
export function blockedFilter(args: BlockedArgs): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (args.sid !== undefined) filter.sid = args.sid;
  if (args.loader !== undefined) filter.loader = requireLoader(args.loader);
  if (args.reason !== undefined) filter.reason = requireReason(args.reason);
  if (args["only-permanent"]) filter.only_permanent = true;
  return filter;
}

export async function runBlocked(
  args: BlockedArgs,
  io: LoaderIo,
  options: LoaderOptions = {},
): Promise<CallResult> {
  // Фильтр собирается до сети, и проверка имён — его часть: негодное
  // имя загрузчика не стоит обращения наружу.
  const filter = blockedFilter(args);
  // `--server` в тело не входит никогда: это клиентский постфильтр
  // (спека, инвариант).
  return await perform(io, options, args.sid ?? "", {
    method: "POST",
    path: FIND_PATH,
    body: { filter },
  }, args.print);
}

export const wbLoaderBlockedCommand = defineCommand({
  path: ["api", "wb-loader-blocked"],
  errorName: "api wb-loader-blocked",
  summary: "POST /admin/wb-loader/blocked-loaders/v1/find — блокировки фермы.",
  usage: "mpu api wb-loader-blocked [--loader ИМЯ] [--reason R] [-p]",
  help: `Показывает заблокированные загрузчики по всей ферме. Без
фильтров — все; --loader (camelCase), --reason и --sid сужают запрос,
--only-permanent оставляет причины, которые сами не восстановятся.

--server — клиентский постфильтр по инстансу: в тело запроса он не
входит, ответ фильтруется после получения.

Имена загрузчиков и причин проверяются по закрытым спискам до сети;
перепутанная форма имени даёт подсказку с правильной.

-p/--print печатает эквивалентный вызов и выходит; токен в нём не
подставляется.

Exit: 0 — успех; 1 — отказ sl-back; 2 — негодное имя загрузчика или
причины.

Пример: mpu api wb-loader-blocked --only-permanent --print`,
  policy: "ro",
  argsSchema: blockedArgs,
  forms: { print: { short: "p" } },
  resultSchema: callResult,
  run: (args: BlockedArgs, io: LoaderIo) => runBlocked(args, io),
  render: (result: CallResult) => renderCall(result),
});

const statusArgs = z.object({
  selector,
  loader: z.string({ error: "нужен LOADER: kebab-слаг загрузчика" })
    .describe("загрузчик kebab-слагом (cards, adv-fullstats, …)"),
  sid: z.string().optional().describe("явный WB sid: прямой режим"),
  "client-id": z.string().optional().describe("сузить селектор до клиента"),
  print: z.boolean().default(false).describe("напечатать вызов и выйти"),
});

type StatusArgs = z.infer<typeof statusArgs>;

/** Общий ход четырёх команд «селектор + загрузчик»: путь и метод свои. */
async function runOnLoader(
  args: StatusArgs,
  io: LoaderIo,
  options: LoaderOptions,
  method: string,
  tail: string,
  body?: unknown,
): Promise<CallResult> {
  const slug = requireSlug(args.loader);
  const target = targetOf(io, {
    selector: args.selector,
    sid: args.sid,
    clientId: args["client-id"],
  });
  return await perform(io, options, target.sid, {
    method,
    path: loaderPath(target.sid, slug, tail),
    body,
  }, args.print);
}

export const wbLoaderStatusCommand = defineCommand({
  path: ["api", "wb-loader-status"],
  errorName: "api wb-loader-status",
  summary: "GET …/loaders/<sid>/<loader>/v1/status — состояние загрузчика.",
  usage: "mpu api wb-loader-status СЕЛЕКТОР LOADER [--sid SID] [-p]",
  help: `Читает состояние одного загрузчика кабинета. LOADER — слаг
(cards, adv-fullstats), не camelCase: слаг идёт сегментом пути.

Цель — селектор либо --sid; при --sid или селекторе формы sid кэш не
открывается вовсе.

Exit: 0 — успех; 1 — отказ sl-back; 2 — негодный слаг, нерезолвимый
селектор, несколько кабинетов.

Пример: mpu api wb-loader-status 777 cards`,
  policy: "ro",
  argsSchema: statusArgs,
  forms: targetForms,
  resultSchema: callResult,
  run: (args: StatusArgs, io: LoaderIo) =>
    runOnLoader(args, io, {}, "GET", "status"),
  render: (result: CallResult) => renderCall(result),
});

export const wbLoaderLoadCommand = defineCommand({
  path: ["api", "wb-loader-load"],
  errorName: "api wb-loader-load",
  summary: "POST …/v1/load — форс-прогон отложенной задачи.",
  usage: "mpu api wb-loader-load СЕЛЕКТОР LOADER [--sid SID] [-p]",
  help: `Запускает отложенную задачу загрузчика немедленно, не
дожидаясь его цикла. Читающий аналог — mpu api wb-loader-status.

LOADER — слаг. Цель — селектор либо --sid.

Exit: 0 — успех; 1 — отказ sl-back; 2 — ошибки ввода и резолва.

Пример: mpu api wb-loader-load 777 cards`,
  policy: "rw",
  argsSchema: statusArgs,
  forms: targetForms,
  resultSchema: callResult,
  run: (args: StatusArgs, io: LoaderIo) =>
    runOnLoader(args, io, {}, "POST", "load"),
  render: (result: CallResult) => renderCall(result),
});

const configArgs = z.object({
  selector,
  loader: z.string({ error: "нужен LOADER: kebab-слаг загрузчика" })
    .describe("загрузчик kebab-слагом"),
  sid: z.string().optional().describe("явный WB sid: прямой режим"),
  "client-id": z.string().optional().describe("сузить селектор до клиента"),
  enable: z.boolean().default(false).describe("включить загрузчик кабинету"),
  disable: z.boolean().default(false).describe("выключить загрузчик кабинету"),
  reset: z.boolean().default(false).describe("снять дельту кабинета"),
  print: z.boolean().default(false).describe("напечатать вызов и выйти"),
});

type ConfigArgs = z.infer<typeof configArgs>;

/**
 * Ровно один из трёх флагов правки либо ни одного. Проверка до сети:
 * «последний выигрывает» здесь означал бы включить там, где просили
 * выключить, и узнал бы об этом оператор по состоянию фермы.
 */
export function configMode(
  args: ConfigArgs,
): "read" | "enable" | "disable" | "reset" {
  const given = ([["enable", args.enable], ["disable", args.disable], [
    "reset",
    args.reset,
  ]] as const).filter(([, on]) => on).map(([name]) => name);
  if (given.length === 0) return "read";
  if (given.length > 1) {
    throw new UsageError(
      `флаги ${given.map((name) => `--${name}`).join(" и ")} взаимоисключающи`,
      { advice: "оставь что-то одно" },
    );
  }
  return given[0];
}

export async function runConfig(
  args: ConfigArgs,
  io: LoaderIo,
  options: LoaderOptions = {},
): Promise<CallResult> {
  const mode = configMode(args);
  // Формы сняты с объекта (спека, таблица): метод у всех трёх мутаций
  // `POST`, а `--reset` отличается **путём**, а не телом — он снимает
  // дельту кабинета целиком, и тела у него нет вовсе. Тело включения —
  // частичная дельта: шлётся ровно `enabled`, остальные поля кабинета
  // не затираются (полная замена стёрла бы чужие настройки молча).
  if (mode === "read") {
    return await runOnLoader(args, io, options, "GET", "config");
  }
  if (mode === "reset") {
    return await runOnLoader(args, io, options, "POST", "config/reset");
  }
  return await runOnLoader(args, io, options, "POST", "config", {
    enabled: mode === "enable",
  });
}

export const wbLoaderConfigCommand = defineCommand({
  path: ["api", "wb-loader-config"],
  errorName: "api wb-loader-config",
  summary: "Конфигурация загрузчика на кабинете: чтение и правка.",
  usage:
    "mpu api wb-loader-config СЕЛЕКТОР LOADER [--enable|--disable|--reset] [-p]",
  help: `Без флагов читает конфигурацию: действующие параметры (база
плюс дельта кабинета), базовые, сырую дельту этого кабинета и перечень
полей, которые можно править per-sid.

--enable/--disable включают и выключают загрузчик на этом кабинете,
--reset снимает дельту. Три флага ВЗАИМОИСКЛЮЧАЮЩИ: два вместе — ошибка
ввода до сети, а не «последний выигрывает».

LOADER — слаг. Цель — селектор либо --sid.

Exit: 0 — успех; 1 — отказ sl-back; 2 — два флага сразу, негодный слаг,
ошибки резолва.

Пример: mpu api wb-loader-config 777 cards --disable`,
  policy: "rw",
  argsSchema: configArgs,
  forms: targetForms,
  resultSchema: callResult,
  run: (args: ConfigArgs, io: LoaderIo) => runConfig(args, io),
  render: (result: CallResult) => renderCall(result),
});

const resetArgs = z.object({
  selector,
  loader: z.string({ error: "нужен LOADER: kebab-слаг загрузчика" })
    .describe("загрузчик kebab-слагом"),
  sid: z.string().optional().describe("явный WB sid: прямой режим"),
  "client-id": z.string().optional().describe("сузить селектор до клиента"),
  state: z.string().optional().describe("частичное состояние как есть (JSON)"),
  from: z.string().optional().describe(
    "дата начала окна YYYY-MM-DD; только для загрузчиков по датам",
  ),
  "and-load": z.boolean().default(false).describe(
    "следом дёрнуть форс-прогон",
  ),
  print: z.boolean().default(false).describe("напечатать вызов и выйти"),
});

const resetResult = callResult.extend({
  loaded: z.unknown().describe("ответ форс-прогона; без --and-load — null"),
});

type ResetArgs = z.infer<typeof resetArgs>;
type ResetResult = z.infer<typeof resetResult>;

/**
 * Тело сброса: пустое, состояние как есть либо собранное из даты.
 * `--state` и `--from` взаимоисключающи — у одного поля не должно быть
 * двух источников (спека, «Окно дозагрузки»).
 */
export function resetBody(args: ResetArgs): unknown {
  if (args.state !== undefined && args.from !== undefined) {
    throw new UsageError("--state и --from взаимоисключающи", {
      advice: "оставь что-то одно",
    });
  }
  if (args.from !== undefined) return { state: stateFromDate(args.from) };
  if (args.state === undefined) return undefined;
  try {
    return { state: JSON.parse(args.state) };
  } catch (err) {
    throw new UsageError(`--state: невалидный JSON: ${reasonOf(err)}`, {
      cause: err,
    });
  }
}

export async function runReset(
  args: ResetArgs,
  io: LoaderIo,
  options: LoaderOptions = {},
): Promise<ResetResult> {
  const body = resetBody(args);
  const reset = await runOnLoader(args, io, options, "POST", "reset", body);
  if (!args["and-load"] || reset.printed) {
    return { ...reset, loaded: null };
  }
  try {
    const loaded = await runOnLoader(args, io, options, "POST", "load");
    return { ...reset, loaded: loaded.response };
  } catch (err) {
    // Сброс уже произошёл, и отказ второго шага его не отменяет: молча
    // упавший вызов оставил бы оператора думать, что состояние прежнее
    // (тот же класс, что частичная запись в `sheet set`).
    throw new DomainError(
      `сброс состояния прошёл, форс-прогон не удался — ${reasonOf(err)}`,
      { cause: err, advice: "прогон можно повторить: mpu api wb-loader-load" },
    );
  }
}

export const wbLoaderResetCommand = defineCommand({
  path: ["api", "wb-loader-reset"],
  errorName: "api wb-loader-reset",
  summary: "POST …/v1/reset — сброс состояния загрузчика и перезапуск.",
  usage:
    "mpu api wb-loader-reset СЕЛЕКТОР LOADER [--state JSON|--from ДАТА] [--and-load] [-p]",
  help: `Сбрасывает состояние загрузчика: ближайший прогон пересчитает
окно. Без опций тело пустое.

Окно дозагрузки задаётся одним из двух ВЗАИМОИСКЛЮЧАЮЩИХ способов:
--state кладёт частичное состояние как есть, --from собирает состояние
с датой НА ДЕНЬ РАНЬШЕ указанной — загрузчик идёт вперёд по дате и
начинает со следующего дня после сохранённого. Два флага вместе —
ошибка ввода до сети.

ВАЖНО: верхняя граница окна у таких загрузчиков всегда «вчера». Точный
участок задать нельзя — свежие дни будут перезалиты. Это свойство
загрузчика, а не команды.

--and-load следом дёргает форс-прогон. Отказ этого шага не отменяет
сброса: он уже произошёл, и сообщение это скажет.

Exit: 0 — успех; 1 — отказ sl-back; 2 — --state вместе с --from,
негодная дата, ошибки резолва.

Пример: mpu api wb-loader-reset 777 orders --from 2026-08-01 --and-load`,
  policy: "rw",
  argsSchema: resetArgs,
  forms: targetForms,
  resultSchema: resetResult,
  run: (args: ResetArgs, io: LoaderIo) => runReset(args, io),
  render: (result: ResetResult) => renderCall(result),
});

const resumeArgs = z.object({
  selector,
  loader: z.string().optional().describe(
    "загрузчик camelCase; без него — показ",
  ),
  sid: z.string().optional().describe("явный WB sid: прямой режим"),
  "client-id": z.string().optional().describe("сузить селектор до клиента"),
  all: z.boolean().default(false).describe("снять блокировки со всех"),
  print: z.boolean().default(false).describe("напечатать вызов и выйти"),
});

type ResumeArgs = z.infer<typeof resumeArgs>;

export async function runResume(
  args: ResumeArgs,
  io: LoaderIo,
  options: LoaderOptions = {},
): Promise<CallResult> {
  if (args.all && args.loader !== undefined) {
    throw new UsageError("--all и позиционный loader взаимоисключающи", {
      advice: "оставь что-то одно",
    });
  }
  const loader = args.loader === undefined
    ? undefined
    : requireLoader(args.loader);
  const target = targetOf(io, {
    selector: args.selector,
    sid: args.sid,
    clientId: args["client-id"],
  });
  // Показ — чтение: снятие блокировок не вызывается ни при каких
  // входах (спека, инвариант).
  if (loader === undefined && !args.all) {
    return await perform(io, options, target.sid, {
      method: "POST",
      path: FIND_PATH,
      body: { filter: { sid: target.sid } },
    }, args.print);
  }
  const filter: Record<string, unknown> = { sid: target.sid };
  if (loader !== undefined) filter.loader = loader;
  return await perform(io, options, target.sid, {
    method: "POST",
    path: RESUME_PATH,
    body: { filter },
  }, args.print);
}

export const wbLoaderResumeCommand = defineCommand({
  path: ["api", "wb-loader-resume"],
  errorName: "api wb-loader-resume",
  summary: "Показать блокировки кабинета или снять их.",
  usage: "mpu api wb-loader-resume СЕЛЕКТОР [LOADER] [--all] [-p]",
  help: `Без LOADER и без --all показывает блокировки кабинета —
только чтение, снятие не вызывается. С LOADER (camelCase) снимает
блокировку одного загрузчика, с --all — всех.

--all вместе с позиционным LOADER — ошибка ввода: оставь что-то одно.

Цель — селектор либо --sid.

Exit: 0 — успех; 1 — отказ sl-back (403 — не хватает роли); 2 — ошибки
ввода и резолва.

Пример: mpu api wb-loader-resume 777 wbCards`,
  policy: "rw",
  argsSchema: resumeArgs,
  forms: targetForms,
  resultSchema: callResult,
  run: (args: ResumeArgs, io: LoaderIo) => runResume(args, io),
  render: (result: CallResult) => renderCall(result),
});

function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/** Команды группы в порядке справки. */
export const wbLoaderCommands: readonly Command[] = [
  wbLoaderBlockedCommand,
  wbLoaderConfigCommand,
  wbLoaderLoadCommand,
  wbLoaderResetCommand,
  wbLoaderResumeCommand,
  wbLoaderStatusCommand,
];
