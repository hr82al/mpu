/**
 * Команда `mpu logs` (`docs/specs/logs.md`): логи сервисов стенда — по
 * умолчанию запросом в Loki, `--via portainer` — снимком одного
 * контейнера из Docker API.
 *
 * Здесь порядок веток вызова и разбор аргументов; сборка запроса —
 * `query.ts`, печать записей — `render.ts`, слежение — `follow.ts`,
 * legacy-снимок — `snapshot.ts`, границы внешних систем — `sources.ts`.
 */

import { z } from "@zod/zod";
import {
  type Command,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import { type LokiAccess, LokiError, requireLokiAccess } from "../loki/mod.ts";
import { resolveSelector } from "../selector/mod.ts";
import { type LogsCache, openLogsCache } from "./cache.ts";
import { lokiFailure } from "./failure.ts";
import { followEntries } from "./follow.ts";
import {
  buildLogQl,
  parseSince,
  toNanoseconds,
  windowStartMs,
} from "./query.ts";
import { LOKI_MAX_ENTRIES, readNewest } from "./pages.ts";
import {
  entryRecords,
  type LogRecord,
  recordEntries,
  recordSnapshot,
  snapshotRecords,
} from "./records.ts";
import { formatEntries, JSON_LINES, textEntries } from "./render.ts";
import { readSnapshot } from "./snapshot.ts";
import {
  type ListAllContainerNames,
  listAllContainerNamesOverHttp,
  type LogStream,
  type ReadContainerLogs,
  readContainerLogsOverHttp,
  type ReadLoki,
  readLokiOverHttp,
  waitFor,
} from "./sources.ts";

/** Имена хостов, которые берутся как есть, без резолва селектора. */
const DIRECT_HOST = /^(sl-\d+|wb-\d+|dt-\d+|wb-clusters|wb-positions)$/;

/** Окно разового запроса по умолчанию — последние 5 минут. */
const ONE_SHOT_WINDOW_MS = 5 * 60_000;

/** Окно начальной порции слежения по умолчанию — последние 10 секунд. */
const FOLLOW_WINDOW_MS = 10_000;

/** Значение первого аргумента и второго, включающее `ls`-режимы. */
const LIST = "ls";

const argsSchema = z.object({
  selector: z.string().optional().describe(
    "sl-N/wb-N/dt-N/wb-clusters/wb-positions | client_id/ss/title |" +
      " имя сервиса; не задан — все хосты",
  ),
  service: z.string().optional().describe(
    "loki: значение compose_service; portainer: подстрока имени" +
      " контейнера",
  ),
  via: z.string().default("loki").describe("источник: loki | portainer"),
  tail: z.number().default(200).describe("сколько последних строк, > 0"),
  since: z.string().optional().describe(
    "10m/1h/30s/2d или unix-ts; loki по умолчанию 5m",
  ),
  timestamps: z.boolean().default(false).describe("префикс времени у строк"),
  "no-stdout": z.boolean().default(false).describe("не показывать stdout"),
  "no-stderr": z.boolean().default(false).describe("не показывать stderr"),
  grep: z.array(z.string()).default([]).describe(
    "loki: подстрока (LogQL |=); повторяемый, AND",
  ),
  "grep-regex": z.array(z.string()).default([]).describe(
    "loki: regex по строке (LogQL |~); повторяемый, AND",
  ),
  grep_regex: z.array(z.string()).default([]).describe(
    "то же, что --grep-regex (второе написание оригинала)",
  ),
  level: z.string().optional().describe(
    "loki: detected_level — error/warn/info/debug",
  ),
  client: z.number().optional().describe(
    "loki: client_id подстрокой десятичной записи — совпадёт и порт" +
      " (cross-service)",
  ),
  follow: z.boolean().default(false).describe(
    "следить за новыми записями; не через тул mpu-mcp, только loki",
  ),
  json: z.boolean().default(false).describe(
    "результат JSON; у follow — JSON Lines, запись на строку",
  ),
});

const resultSchema = z.object({
  /** Что за вывод: списки `ls`, записи Loki, слежение или снимок. */
  kind: z.enum(["hosts", "services", "entries", "follow", "snapshot"]),
  /** Имена `ls`-режимов; вне их — пусто. */
  names: z.array(z.string()).readonly(),
  /** Записи разового запроса по возрастанию времени; вне его — пусто. */
  entries: z.array(
    z.object({
      tsNs: z.string(),
      line: z.string(),
      labels: z.record(z.string(), z.string()),
    }),
  ).readonly().describe(
    "перечень усечён `limit:` (вход tail): последние N записей окна, а " +
      "сколько их в окне всего, источник не сообщает",
  ),
  /** Снимок Portainer; вне legacy-пути — null. */
  snapshot: z.object({
    container: z.string(),
    timestamps: z.boolean().describe(
      "Docker ставил метку времени в начало строк",
    ),
    stdout: z.string().describe(
      "последние строки stdout, не больше `limit:`; сколько их в логе " +
        "всего, Docker не сообщает",
    ),
    stderr: z.string().describe(
      "последние строки stderr, не больше `limit:`; сколько их в логе " +
        "всего, Docker не сообщает",
    ),
  }).nullable(),
});

/** Разобранные аргументы `mpu logs`. */
export type LogsArgs = z.infer<typeof argsSchema>;

/** Результат вызова: из него рендерится stdout. */
export type LogsResult = z.infer<typeof resultSchema>;

/**
 * Подмены для тестов: сети у них нет, а часы и пауза обязаны быть
 * управляемыми (`ts/CLAUDE.md`: сон стеной в тестах запрещён).
 */
export interface LogsOptions {
  readonly readLoki?: ReadLoki;
  readonly listAllContainerNames?: ListAllContainerNames;
  readonly readContainerLogs?: ReadContainerLogs;
  readonly stream?: LogStream;
  readonly now?: () => number;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Предел записей на запрос у Loki; не задан — `LOKI_MAX_ENTRIES`. */
  readonly pageSize?: number;
  /** Остановка слежения; не задана — Ctrl+C процесса. */
  readonly signal?: AbortSignal;
}

const command = defineCommand({
  choices: {
    loki: { input: "via", purpose: "источник — Loki (по умолчанию)" },
    portainer: {
      input: "via",
      purpose: "источник — снимок одного контейнера через Portainer",
    },
  },
  path: ["logs"],
  keys: { service: "service", limit: "tail" },
  modes: {
    hosts: {
      purpose: "хосты с логами",
      label: "хосты",
      fixed: { selector: "ls" },
      keys: {},
    },
    services: {
      purpose: "сервисы хоста",
      label: "сервисы",
      fixed: { service: "ls" },
      keys: { target: "selector" },
    },
  },
  // Однострока — из слепка дерева: имя и описание переехавшей команды
  // видит режим дополнения, и расходиться с эталоном им незачем.
  summary: "Логи со стенда (Loki по умолчанию, portainer для legacy snapshot).",
  usage:
    "mpu logs [loki|portainer] [target: СЕЛЕКТОР] [service: СЕРВИС] [фильтры]",
  help: `Звать, когда надо понять, что сервис писал в лог: ошибки,
конкретный клиент, окно времени — с одного хоста или со всей фермы.

Без target: — все хосты. target: — sl-N / wb-N / dt-N /
wb-clusters / wb-positions как есть; клиентский селектор (client_id,
spreadsheet_id, заголовок) — в сервер sl-N. service: — сервис; без
target: он ищется со всех хостов.

Списки из кэша, без сети: \`mpu logs hosts\` — хосты,
\`mpu logs services target: sl-1\` — сервисы хоста; кэш наполняют
\`mpu init\` и \`mpu update\`.

Фильтры Loki, И между собой: grep: S (подстрока), grep-regex: S,
level: error|warn|info|debug, client: N (подстрока числа в строке —
совпадёт и порт). Потоки: no-stdout, no-stderr.

Окно: since: 30s|10m|1h|2d или unix-ts (умолчание 5m, слежение 10s);
limit: N > 0 (200); timestamps — префикс
YYYY-MM-DDThh:mm:ss.mmmZ; follow — опрос раз в 2 с до Ctrl+C;
недоступен только вызовом тула (mpu-mcp). Печать всегда по возрастанию
времени.

via: portainer — снимок логов одного контейнера: нужны target: и
service: (имя контейнера или подстрока), фильтры и follow нельзя,
байты потоков идут как есть.

Env: LOKI_URL; PORTAINER_API_KEY, PORTAINER_VERIFY_TLS, sl_<N>_portainer.

Exit: 0 — успех, в том числе пустой вывод; 1 — отказ источника; 2 —
ошибка ввода, конфигурации или резолва.`,
  examples: [
    "mpu logs target: sl-1 service: wb-loader level: error since: 1h limit: 500",
    "mpu logs hosts",
    "mpu logs services target: sl-1",
  ],
  policy: "ro",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    service: { positional: "one" },
    tail: { short: "n" },
    timestamps: { short: "t" },
    follow: { short: "f" },
  },
  resultSchema,
  items: {
    records: (result) => recordsOf(result),
    with: (result, records) => withRecords(result, records),
  },
  run: (args, io) => runLogs(args, io),
  render: (result, args) => renderLogs(result, args),
  streams: (args) => args.follow,
});

/**
 * Слежение живёт до Ctrl+C, которого у вызова тулом (`mpu-mcp`) нет
 * (`docs/specs/logs.md`, «Слежение»). Форма входа объектом аргументов —
 * это и есть такой вызов, поэтому `follow: true` отвергается здесь;
 * разбор argv (`invoke`) не меняется, и строке сервера слежение
 * доступно — её клиент умеет и уйти, и отменить (`line-cancel.md`).
 */
export const logsCommand: Command = {
  ...command,
  invokeInput: async (input, io) => {
    if (isRecord(input) && input.follow === true) {
      throw new UsageError("follow доступен только в CLI");
    }
    return await command.invokeInput(input, io);
  },
};

/** Сужение объекта аргументов: до схемы вход — произвольный JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Срез порта исполнения, который потребляет команда: env-файл (адреса
 * Loki и Portainer) и кэш-БД селектора.
 */
type LogsIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "openRemoteOutput" | "signal"
>;

/**
 * Прогон команды. Вынесено из объявления ради подмены источников и
 * часов; команда зовёт эту функцию без подмен.
 */
export async function runLogs(
  args: LogsArgs,
  io: LogsIo,
  options: LogsOptions = {},
): Promise<LogsResult> {
  using cache = openLogsCache(io);
  // `ls`-режимы — раньше всего: им не нужны ни LOKI_URL, ни валидный
  // --via, и `ls` первым аргументом побеждает трактовку этого
  // аргумента как имени сервиса.
  if (args.selector === LIST) return listHosts(cache);
  if (args.service === LIST) return listServices(cache, args.selector ?? "");

  const via = requireVia(args.via);
  const place = splitPositionals(args, cache, via);
  return via === "portainer"
    ? await runSnapshot(args, io, cache, place, options)
    : await runLoki(args, io, cache, place, options);
}

/** Пустой результат: поля заполняет только та ветка, которой они нужны. */
const EMPTY: LogsResult = {
  kind: "entries",
  names: [],
  entries: [],
  snapshot: null,
};

function listHosts(cache: LogsCache): LogsResult {
  const names = cache.hosts();
  if (names.length === 0) {
    throw new UsageError(
      "кэш hosts пуст. Запусти `mpu init` или `mpu update`.",
    );
  }
  return { ...EMPTY, kind: "hosts", names };
}

function listServices(cache: LogsCache, host: string): LogsResult {
  // Значение хоста берётся литерально: резолва селектора здесь нет —
  // список показывается ровно для того имени, что набрали.
  const names = cache.services(host);
  if (names.length === 0) {
    throw new UsageError(
      `для host='${host}' нет services в кэше. Проверь host через ` +
        "`mpu logs ls` или обнови кэш через `mpu update`.",
    );
  }
  return { ...EMPTY, kind: "services", names };
}

/** Куда смотрит вызов: хост (до резолва) и сервис. */
interface Place {
  readonly hostArg?: string;
  readonly service?: string;
}

/**
 * Трактовка первого аргумента: единственный аргумент, не похожий на
 * прямой хост, но известный кэшу как сервис, — это сервис со всех
 * хостов (`mpu logs wb-loader`). На legacy-пути такой трактовки нет:
 * там оба аргумента обязательны и второй — имя контейнера.
 */
function splitPositionals(
  args: LogsArgs,
  cache: LogsCache,
  via: "loki" | "portainer",
): Place {
  if (
    args.selector !== undefined &&
    args.service === undefined &&
    via === "loki" &&
    !DIRECT_HOST.test(args.selector) &&
    cache.hasService(args.selector)
  ) {
    return { service: args.selector };
  }
  return { hostArg: args.selector, service: args.service };
}

/** Разовый запрос или слежение — оба через Loki. */
async function runLoki(
  args: LogsArgs,
  io: LogsIo,
  cache: LogsCache,
  place: Place,
  options: LogsOptions,
): Promise<LogsResult> {
  const tail = requireTail(args.tail);
  const since = args.since === undefined ? undefined : parseSince(args.since);
  const client = args.client === undefined
    ? undefined
    : requireInteger(args.client, "--client");
  const access = requireLoki(io);
  const logql = buildLogQl({
    host: hostOf(place.hostArg, cache, io),
    service: place.service,
    noStdout: args["no-stdout"],
    noStderr: args["no-stderr"],
    greps: args.grep,
    regexes: [...args["grep-regex"], ...args.grep_regex],
    client,
    level: args.level,
  });
  const now = options.now ?? Date.now;
  const read = options.readLoki ?? readLokiOverHttp;

  if (args.follow) {
    // Остановка приходит портом, а не своим обработчиком сигналов: у
    // строки сервера её шлёт ушедший клиент, у процесса CLI её не
    // бывает вовсе (`platform/line-cancel.md`). Вывод идёт тем же
    // портом потока, что и у команд транспорта, — поэтому кадры
    // уходят клиенту по мере появления, а не по концу строки.
    await followEntries({
      read: (query) => read(access, query),
      now,
      wait: options.wait ?? waitFor,
      stream: options.stream ?? streamOf(io),
      signal: options.signal ?? io.signal,
    }, {
      logql,
      startMs: windowStartMs(since, now(), FOLLOW_WINDOW_MS),
      limit: tail,
      printer: args.json ? JSON_LINES : textEntries(args.timestamps),
    });
    return { ...EMPTY, kind: "follow" };
  }

  try {
    // Последние `limit` записей окна — страницами назад от его конца:
    // больше предела источника за один запрос не отдать
    // (`platform/long-output.md`, §2). Порядок печати — по времени.
    const entries = await readNewest(
      (query) => read(access, query),
      {
        logql,
        startNs: toNanoseconds(windowStartMs(since, now(), ONE_SHOT_WINDOW_MS)),
        endNs: toNanoseconds(now()),
      },
      tail,
      options.pageSize ?? LOKI_MAX_ENTRIES,
    );
    return { ...EMPTY, kind: "entries", entries };
  } catch (err) {
    throw lokiFailure(err, logql);
  }
}

/**
 * Поток вывода команды: тот же порт, которым идут наружу байты команд
 * транспорта. Слежение печатает по мере появления, и кому эти куски
 * достанутся — потокам процесса, кадрам строки или накопителю вызова
 * тула, — решает точка входа, а не команда
 * (`platform/command-contract.md`, `platform/line-cancel.md`).
 */
function streamOf(io: Pick<CommandIo, "openRemoteOutput">): LogStream {
  const encoder = new TextEncoder();
  const stream = io.openRemoteOutput();
  return {
    out: (text) => stream.out(encoder.encode(text)),
    err: (text) => stream.err(encoder.encode(text)),
  };
}

/** Legacy-путь: снимок логов одного контейнера через Portainer. */
async function runSnapshot(
  args: LogsArgs,
  io: LogsIo,
  cache: LogsCache,
  place: Place,
  options: LogsOptions,
): Promise<LogsResult> {
  if (place.hostArg === undefined) {
    throw new UsageError("portainer требует target:");
  }
  if (place.service === undefined) {
    throw new UsageError(
      "portainer требует service:",
    );
  }
  if (args.follow) {
    throw new UsageError("follow не поддерживается с portainer");
  }
  // Отклонение-fix спеки: оригинал молча игнорировал фильтры Loki на
  // этом пути, и вывод выглядел отфильтрованным.
  if (
    args.grep.length > 0 || args["grep-regex"].length > 0 ||
    args.grep_regex.length > 0 || args.level !== undefined ||
    args.client !== undefined
  ) {
    throw new UsageError(
      "grep:/grep-regex:/level:/client: поддерживаются только с loki",
    );
  }
  const tail = requireTail(args.tail);
  const since = args.since === undefined ? undefined : parseSince(args.since);
  const now = options.now ?? Date.now;
  const snapshot = await readSnapshot(
    {
      cache,
      env: io.envFile,
      names: options.listAllContainerNames ?? listAllContainerNamesOverHttp,
      logs: options.readContainerLogs ?? readContainerLogsOverHttp,
    },
    serverNumberOf(place.hostArg, cache, io),
    place.service,
    {
      stdout: !args["no-stdout"],
      stderr: !args["no-stderr"],
      tail,
      timestamps: args.timestamps,
      sinceUnix: since === undefined
        ? undefined
        : Math.floor(windowStartMs(since, now(), 0) / 1000),
    },
  );
  // stderr-часть снимка печатается здесь: рендер отдаёт только stdout,
  // а спека требует развести потоки (см. `sources.ts`, `LogStream`).
  if (snapshot.stderr !== "") {
    await (options.stream ?? streamOf(io)).err(snapshot.stderr);
  }
  return {
    ...EMPTY,
    kind: "snapshot",
    snapshot: { ...snapshot, timestamps: args.timestamps },
  };
}

/**
 * Результат в stdout. JSON — тот же, что давал общий `--json`; у слежения
 * записи уже ушли JSON Lines по мере поступления, в конце — ничего.
 */
function renderLogs(result: LogsResult, args: LogsArgs): string {
  if (!args.json) return renderText(result, args);
  return result.kind === "follow" ? "" : JSON.stringify(result, null, 2);
}

/** Текст результата для человека; stdout и ничего кроме него. */
function renderText(result: LogsResult, args: LogsArgs): string {
  switch (result.kind) {
    case "hosts":
    case "services":
      return result.names.map((name) => `${name}\n`).join("");
    case "entries":
      return formatEntries(result.entries, args.timestamps);
    case "follow":
      // Ctrl+C прерывает слежение переводом строки — записи печатались
      // по мере поступления, здесь остался только он.
      return "\n";
    case "snapshot":
      return result.snapshot?.stdout ?? "";
    default: {
      const never: never = result.kind;
      throw new TypeError(`неизвестный вид вывода: ${never}`);
    }
  }
}

/**
 * Результат как коллекция (`platform/long-output.md`, §3): строки лога —
 * записи, имена `hosts`/`services` — скаляры. Вид результата — данные
 * границы контракта, поэтому ветвление по нему здесь, рядом с рендером.
 */
function recordsOf(result: LogsResult): readonly unknown[] {
  switch (result.kind) {
    case "hosts":
    case "services":
      return result.names;
    case "entries":
      return entryRecords(result.entries);
    case "snapshot":
      return result.snapshot === null ? [] : snapshotRecords(result.snapshot);
    case "follow":
      // Поток отбору не подлежит: отказ до исполнения (`streams`).
      return [];
    default: {
      const never: never = result.kind;
      throw new TypeError(`неизвестный вид вывода: ${never}`);
    }
  }
}

/**
 * Тот же результат с отобранными записями. Записи — те, что отдал
 * `recordsOf` этому же результату, поэтому приведение типа верно по
 * построению; итог проверяет схема результата.
 */
function withRecords(
  result: LogsResult,
  records: readonly unknown[],
): LogsResult {
  switch (result.kind) {
    case "hosts":
    case "services":
      return { ...result, names: records as string[] };
    case "entries":
      return { ...result, entries: recordEntries(records as LogRecord[]) };
    case "snapshot":
      return result.snapshot === null ? result : {
        ...result,
        snapshot: recordSnapshot(result.snapshot, records as LogRecord[]),
      };
    case "follow":
      return result;
    default: {
      const never: never = result.kind;
      throw new TypeError(`неизвестный вид вывода: ${never}`);
    }
  }
}

/** Хост Loki: прямое имя как есть, иначе сервер резолва селектора. */
function hostOf(
  hostArg: string | undefined,
  cache: LogsCache,
  io: LogsIo,
): string | undefined {
  if (hostArg === undefined) return undefined;
  if (DIRECT_HOST.test(hostArg)) return hostArg;
  return `sl-${serverNumberOf(hostArg, cache, io)}`;
}

/** Номер сервера селектора; до клиента запрос не сужается. */
function serverNumberOf(
  selector: string,
  cache: LogsCache,
  io: LogsIo,
): number {
  return resolveSelector(
    { cache: { query: cache.query }, env: io.envFile },
    selector,
  ).serverNumber;
}

/** Значение `--via`; прочие значения — ошибка ввода. */
function requireVia(value: string): "loki" | "portainer" {
  if (value === "loki" || value === "portainer") return value;
  throw new UsageError(`--via '${value}', ожидается 'loki' или 'portainer'`);
}

/** Значение `limit:`: целое больше нуля, до сети и до сборки запроса. */
function requireTail(raw: number): number {
  const value = requireInteger(raw, "limit");
  if (value > 0) return value;
  throw new UsageError(`limit: ожидается целое > 0, получено '${raw}'`);
}

/**
 * Целое значение флага. Тип входа проверила схема (число), смысл —
 * здесь: целочисленность и диапазон объявляет команда
 * (`platform/command-contract.md`, «Ввод/вывод»).
 */
function requireInteger(raw: number, flag: string): number {
  if (!Number.isSafeInteger(raw)) {
    throw new UsageError(`${flag}: ожидается целое, получено '${raw}'`);
  }
  return raw;
}

/**
 * Базовый URL Loki. Отсутствие ключа — ошибка конфигурации со своим
 * текстом: атом называет ключ, команда — ещё и место, где его задать.
 */
function requireLoki(io: LogsIo): LokiAccess {
  try {
    return requireLokiAccess(io.envFile);
  } catch (err) {
    if (err instanceof LokiError) {
      throw new UsageError("LOKI_URL не задан в ~/.config/mpu/.env", {
        cause: err,
      });
    }
    throw err;
  }
}
