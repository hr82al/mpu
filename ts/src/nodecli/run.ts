/**
 * Ход вызова обёртки над sl-back CLI (`platform/portainer.md`): резолв
 * селектора, auto-pick, сборка inner-команды и доставка одним из трёх
 * режимов — выполнение, печать ssh-формы, печать локальной формы.
 *
 * Режим выбирается один раз и целиком: смешения не бывает, а
 * inner-команда у всех трёх одна и та же.
 */

import { z } from "@zod/zod";
import { type CacheDb, type CommandIo, UsageError } from "../command/mod.ts";
import { copyToClipboard } from "../clipboard/mod.ts";
import {
  chooseTransport,
  devCliContainer,
  type ExecPlace,
  type HttpCall,
  type OpenChannel,
  runOverPortainer,
  runOverSsh,
  type RunProcess,
  serverCliContainer,
} from "../exec/mod.ts";
import {
  type CacheReader,
  type Candidate,
  formatCandidates,
  resolveSelector,
} from "../selector/mod.ts";
import {
  type Flag,
  type InnerCommand,
  innerText,
  innerTokens,
} from "./inner.ts";

/** Ключ ssh — тот же, что у транспорта (`platform/exec-transport.md`). */
const KEY_FILE = ".ssh/id_rsa";

/** Порт исполнения глазами обёртки. */
export type WrapIo = Pick<
  CommandIo,
  "env" | "envFile" | "openCacheDb" | "openRemoteOutput" | "progress"
>;

/**
 * Входы, общие всем обёрткам без исключения: куда идём и как
 * доставляем (`specs/portainer-wrappers.md`).
 */
export const targetArgs = {
  selector: z.string().describe("клиент: client_id, spreadsheet, title"),
  server: z.string().optional().describe("override сервера: sl-N"),
  print: z.boolean().default(false).describe(
    "напечатать команду и скопировать её в буфер обмена, не выполняя",
  ),
  local: z.boolean().default(false).describe(
    "печатать форму локального стенда; только вместе с --print",
  ),
};

/**
 * Общие входы обёртки, чья inner-команда несёт `--client-id`. У
 * обёрток без него (`*-jobs`, `app-migrations`, `latest-all`) флага нет
 * и в CLI: принимать значение, которое некуда девать, значит молча его
 * терять.
 */
export const commonArgs = {
  ...targetArgs,
  "client-id": z.number().optional().describe(
    "client_id; без него берётся из кандидатов селектора",
  ),
};

export const resultSchema = z.object({
  server: z.string().describe(
    "`sl-<N>` либо `dev:<N>` — где исполняется команда",
  ),
  inner: z.string().describe("собранная inner-команда одной строкой"),
  /** Напечатанная строка команды; у режима выполнения — null. */
  printed: z.string().nullable(),
  /** Вывод inner-команды, если приёмник копил (вызов тула). */
  output: z.string(),
  exitCode: z.number().int().describe("код inner-команды, 1:1"),
});

export type WrapResult = z.infer<typeof resultSchema>;

/**
 * Вывод обёртки: печать даёт строку команды, выполнение — вывод
 * inner-команды (в CLI он уже ушёл в потоки, поэтому пуст). Один на всё
 * семейство: семь копий разъехались бы.
 */
export function renderWrap(result: WrapResult): string {
  return result.printed === null ? result.output : `${result.printed}\n`;
}

/**
 * Общая часть разобранных аргументов, как она приходит из схемы
 * `commonArgs`: имена — argv'шные, включая kebab. Сборщик ниже переводит
 * её в `WrapArgs`, чтобы перевод жил в одном месте на всё семейство.
 */
export type CommonArgs = {
  readonly selector: string;
  readonly server?: string;
  readonly print: boolean;
  readonly local: boolean;
  readonly "client-id"?: number;
  /**
   * `-v/--verbose`; объявлен он только у
   * `ozon-recalculate-expenses` (спека семейства), поэтому поле
   * необязательное: у остальных шести его в аргументах нет вовсе.
   */
  readonly verbose?: boolean;
};

/**
 * Общая часть входов любой обёртки. Каждая обёртка объявляет её
 * `commonArgs` и передаёт сюда весь свой объект аргументов: разбирать
 * пять одних и тех же полей в каждой из семи команд значит семь правок
 * на одно изменение требования.
 */
export function commonArgsOf(args: CommonArgs): WrapArgs {
  return {
    selector: args.selector,
    server: args.server,
    print: args.print,
    local: args.local,
    clientId: args["client-id"],
    verbose: args.verbose,
  };
}

/** Разобранные общие аргументы: что нужно машинерии от любой обёртки. */
export interface WrapArgs {
  readonly selector: string;
  readonly server?: string;
  readonly print: boolean;
  readonly local: boolean;
  readonly clientId?: number;
  /** Печатать inner-команду служебной строкой перед доставкой. */
  readonly verbose?: boolean;
  /**
   * Номер сервера dev-ноды из селектора `dev:N`. Задан — вызов идёт
   * мимо резолва и мимо фермы: у dev-ноды нет ни кэша клиентов, ни
   * ssh-обёртки прода (`specs/portainer-wrappers.md`, ветка `dev:N`).
   */
  readonly devServerNumber?: number;
}

/** Что обёртка знает про свою inner-команду. */
export interface WrapSpec {
  readonly service: string;
  readonly method: string;
  /**
   * Идёт ли в inner-команду `--client-id`. `auto` (умолчание) — флаг
   * первый, значение явное либо из кандидатов селектора; `none` — его
   * нет вовсе, и кандидаты ради него не спрашиваются: метод сам
   * разъезжается по клиентам (`clientsMigrations latestAll`) либо
   * работает на уровне сервера (`*-jobs`, `appMigrations`).
   *
   * `placed` — значение резолвится тем же правилом, но место флага
   * выбирает сама обёртка (`context.clientId`): у `ssLoader load`
   * порядок флагов метода начинается не с него, а порядок — контракт
   * нижестоящего парсера, не наш выбор.
   */
  readonly clientId?: "auto" | "none" | "placed";
  /**
   * Доменные флаги после `--client-id`; порядок — контракт спеки
   * семейства, поэтому список, а не словарь.
   */
  readonly flags: (context: WrapContext) => readonly Flag[];
}

/** Что доступно обёртке при сборке её флагов. */
export interface WrapContext {
  /**
   * Разрешённый client_id — только у режима `placed`: остальным он не
   * нужен, потому что флаг ставит машинерия.
   */
  readonly clientId?: number;
  readonly candidates: readonly Candidate[];
  /** Значение из кандидатов, если оно там одно; иначе отказ ввода. */
  readonly pick: (flag: string, of: (c: Candidate) => string | null) => string;
  /**
   * То же значение, но неоднозначность — не отказ, а `undefined`:
   * флаг просто не эмитится. Так ведёт себя `--spreadsheet-id` у
   * `mpu process` (`specs/portainer-wrappers.md`): у него таблица —
   * уточнение, а не адрес вызова.
   */
  readonly pickOrNone: (
    of: (c: Candidate) => string | null,
  ) => string | undefined;
}

/** Подстановки транспорта и буфера: живого контейнера в тестах нет. */
export interface WrapOptions {
  readonly runProcess?: RunProcess;
  readonly openChannel?: OpenChannel;
  readonly httpCall?: HttpCall;
  readonly copy?: (text: string) => Promise<boolean>;
}

/** Исполняет или печатает вызов обёртки. */
export async function runWrap(
  spec: WrapSpec,
  args: WrapArgs,
  io: WrapIo,
  options: WrapOptions = {},
): Promise<WrapResult> {
  // `--local` без `--print` — ошибка ввода, а не молчаливое выполнение
  // в проде (отклонение `fix` спеки семейства).
  if (args.local && !args.print) {
    throw new UsageError("--local имеет смысл только вместе с --print");
  }
  let db: CacheDb | undefined;
  // Кэш открывается первым же запросом резолва: ветке `dev:N` он не
  // нужен вовсе, и неинициализированная БД не должна ей мешать.
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  try {
    const dev = args.devServerNumber;
    const resolved = dev === undefined
      ? resolveSelector({ cache, env: io.envFile }, args.selector, {
        server: args.server,
      })
      // На dev-ноде прод-кэша клиентов нет, поэтому кандидатов нет тоже:
      // client_id там называет человек.
      : { selector: args.selector, serverNumber: dev, candidates: [] };
    // Кандидаты ради `--client-id` спрашиваются только там, где флаг
    // есть: у обёрток уровня сервера отказ auto-pick означал бы отказ
    // вызова, которому client_id не нужен вовсе.
    if (dev !== undefined && args.server !== undefined) {
      // Молча проглотить нельзя: оператор назвал сервер, а вызов ушёл бы
      // на другой — тот же довод, что у `--local` без `--print`.
      throw new UsageError("--server не имеет смысла с селектором dev:N");
    }
    if (
      dev !== undefined && spec.clientId !== "none" &&
      args.clientId === undefined
    ) {
      throw new UsageError(
        "dev-селектор требует --client-id: кандидатов на dev-ноде нет",
      );
    }
    const clientId = spec.clientId === "none" ? undefined : args.clientId ??
      Number(pickOf(resolved.candidates, "--client-id", clientIdOf));
    const inner: InnerCommand = {
      service: spec.service,
      method: spec.method,
      flags: [
        ...(clientId === undefined || spec.clientId === "placed"
          ? []
          : [{ name: "client-id", value: clientId }]),
        ...spec.flags({
          // Только режиму `placed`: иначе обёртка в режиме `auto` могла
          // бы выписать второй `--client-id` рядом с машинным.
          clientId: spec.clientId === "placed" ? clientId : undefined,
          candidates: resolved.candidates,
          pick: (flag, of) => pickOf(resolved.candidates, flag, of),
          pickOrNone: (of) => singleOf(resolved.candidates, of),
        }),
      ],
    };
    // Сборка идёт до всякой доставки: SafeToken обязан отказать раньше
    // печати и раньше сети (инвариант спеки).
    const text = innerText(inner);
    const server = dev === undefined
      ? `sl-${resolved.serverNumber}`
      : `dev:${dev}`;
    // `# inner: …` идёт служебным каналом (в CLI это stderr) во всех трёх
    // режимах и обычный вывод не подменяет: в print-режимах строка команды
    // всё равно уходит в stdout (спека семейства, «Особенности»).
    if (args.verbose === true) io.progress(`# inner: ${text}`);

    if (!args.print) {
      return await execute(inner, { io, options, cache }, {
        place: dev === undefined
          ? { kind: "server", serverNumber: resolved.serverNumber }
          : { kind: "dev", serverNumber: dev },
        server,
        text,
      });
    }
    const container = dev === undefined
      ? serverCliContainer(cache, resolved.serverNumber)
      : devCliContainer(dev);
    const printed = args.local
      ? localForm(container, text)
      // Форма dev-ветки — не ssh-обёртка, а вызов соседней команды: до
      // dev-ноды ходит `mpu ssh`, и вставлять её ключ и хост здесь
      // значило бы держать вторую копию его настройки.
      : dev === undefined
      ? sshForm(io, resolved.serverNumber, container, text)
      : `mpu ssh dev:${dev} -- ${text}`;
    // Недоступность буфера молчалива: строка уже напечатана, копирование
    // — довесок (`platform/clipboard.md`).
    await (options.copy ?? copyToClipboard)(printed);
    return { server, inner: text, printed, output: "", exitCode: 0 };
  } finally {
    // Кэш закрывается детерминированно: у MCP-сервера процесс живёт
    // долго, и незакрытый хэндл SQLite копился бы на каждый вызов
    // тула (`ts/CLAUDE.md`, «Ошибки»).
    db?.[Symbol.dispose]();
  }
}

/** Выполнение inner-команды в контейнере сервера через транспорт. */
async function execute(
  inner: InnerCommand,
  deps: {
    readonly io: WrapIo;
    readonly options: WrapOptions;
    readonly cache: CacheReader;
  },
  shown: {
    readonly place: ExecPlace;
    readonly server: string;
    readonly text: string;
  },
): Promise<WrapResult> {
  const { io, options } = deps;
  const output = io.openRemoteOutput();
  const tokens = innerTokens(inner);
  const command: readonly [string, ...string[]] = [
    tokens[0],
    ...tokens.slice(1),
  ];
  // Кэш живой, а не заглушка: Portainer-таргет сервера лежит в нём
  // после `mpu init`, и с пустым кэшем обёртка уходила бы по ssh там,
  // где `mpu ssh` того же сервера идёт Portainer'ом.
  const target = chooseTransport({
    place: shown.place,
    env: io.envFile,
    cache: deps.cache,
  });
  const exitCode = target.kind === "ssh"
    ? await runOverSsh({
      target,
      command,
      stdin: new Uint8Array(),
      keyPath: keyPath(io),
      output,
      run: options.runProcess,
    })
    : await runOverPortainer({
      target,
      command,
      stdin: new Uint8Array(),
      output,
      warn: io.progress,
      http: options.httpCall,
      open: options.openChannel,
    });
  return {
    server: shown.server,
    inner: shown.text,
    printed: null,
    output: output.captured(),
    exitCode,
  };
}

/** Форма ssh-печати: её копируют и вставляют в чужой терминал. */
function sshForm(
  io: WrapIo,
  serverNumber: number,
  container: string,
  inner: string,
): string {
  const host = value(io, `sl_${serverNumber}`);
  if (host === undefined) {
    throw new UsageError(`no sl_${serverNumber} in ~/.config/mpu/.env`);
  }
  const user = value(io, "PG_MY_USER_NAME");
  if (user === undefined) {
    throw new UsageError("PG_MY_USER_NAME not set in ~/.config/mpu/.env");
  }
  return `ssh -i ${keyPath(io)} -t ${user}@${host} ` +
    `'docker exec -it ${container} sh -c "${inner}"'`;
}

/** Форма локального стенда: env-файл здесь не читается вовсе. */
function localForm(container: string, inner: string): string {
  return `${container} sh -c "${inner}"`;
}

/**
 * Значение из кандидатов резолва: явно заданный флаг сюда не доходит, а
 * одно и то же значение у всех кандидатов берётся молча. Разные
 * значения — отказ ввода со списком кандидатов (спека, «Auto-pick»).
 */
function pickOf(
  candidates: readonly Candidate[],
  flag: string,
  of: (candidate: Candidate) => string | null,
): string {
  const only = singleOf(candidates, of);
  if (only !== undefined) return only;
  const list = formatCandidates(candidates);
  throw new UsageError(
    `cannot resolve ${flag} from selector; pass ${flag}`,
    // Пустой список — отсутствие подробностей, а не пустая строка:
    // иначе за отказом печатается лишний перевод строки (приём
    // `../selector/error.ts`).
    { details: list === "" ? undefined : list.slice(0, -1) },
  );
}

/** Единственное значение среди кандидатов; иначе `undefined`. */
function singleOf(
  candidates: readonly Candidate[],
  of: (candidate: Candidate) => string | null,
): string | undefined {
  const values = new Set(
    candidates.map(of).filter((item): item is string => item !== null),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function clientIdOf(candidate: Candidate): string | null {
  return candidate.clientId === null ? null : String(candidate.clientId);
}

function keyPath(io: WrapIo): string {
  const home = io.env("HOME");
  if (home === undefined || home === "") {
    throw new UsageError("путь к ssh-ключу не определён: HOME не задан");
  }
  return `${home}/${KEY_FILE}`;
}

/** Значение ключа env-файла; пустое равнозначно отсутствию. */
function value(io: WrapIo, name: string): string | undefined {
  const raw = io.envFile.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}
