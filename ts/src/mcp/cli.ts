/**
 * Поверхность `mpu mcp` — запуск долгоживущего сервера
 * (`platform/mcp-server.md`, «CLI-контракт»). Контракту команды она не
 * подчиняется намеренно: у процесса, который слушает сокет, нет
 * результата, который рендерится в текст (`platform/command-contract.md`,
 * открытый вопрос про команды без проекции результата). Поэтому её
 * обслуживает точка входа, а не реестр тулов.
 */

import {
  type Command,
  type CommandIo,
  NotFoundIoError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import { parseStore } from "../config/mod.ts";
import { resolveLegacyBin } from "../legacy/mod.ts";
import type { Profile } from "./mod.ts";
import {
  DEFAULT_PORT,
  LOOPBACK,
  type RunningServer,
  serveMcp,
} from "./server.ts";
import { ensureAccessToken } from "./token.ts";
import { VERSION, versionMismatch } from "../version.ts";
import type { InvokeLog } from "../invokelog/mod.ts";

/** Приёмник диагностики: всё, что нужно этой поверхности от вывода. */
export interface ErrorSink {
  readonly stderr: (text: string) => void;
}

/** Зависимости запуска: окружение, вывод, реестр и способ остановки. */
export interface McpServerRun {
  readonly io: CommandIo;
  readonly output: ErrorSink;
  /** Реестр передаётся снаружи: иначе модуль зависел бы от реестра, а
   * реестр — от него. */
  readonly commands: readonly Command[];
  /** Остановка сервера: сигнал гасит слушающий сокет. */
  readonly signal?: AbortSignal;
  /** Зовётся, когда сокет уже слушает: точка синхронизации тестов. */
  readonly onListen?: (server: RunningServer) => void;
  /** Журнал вызовов: запись на каждый вызов тула. */
  readonly log: InvokeLog;
}

/** Ключ конфига с портом по умолчанию (`platform/config.md`). */
const PORT_KEY = "mcp.port";

/** Разобранные флаги запуска; ошибка ввода — текст для stderr. */
type Options =
  | { readonly profiles: readonly Profile[]; readonly port: number | undefined }
  | { readonly usage: string };

/**
 * Срез порта для шагов запуска, которые его потребляют: порт из
 * конфига и сверка версии подпроцессом (той же парой «ключ конфига и
 * HOME», по которой путь к реализации ищет маршрут `legacy`). Сам сервер получает порт
 * целиком — он раздаёт его произвольным командам.
 */
type StartupIo = Pick<CommandIo, "env" | "readConfigStore" | "runLegacy">;

/**
 * Поднимает сервер и ждёт его остановки. Возвращает код завершения
 * процесса: 2 — ошибка ввода, 1 — порт занят.
 */
export async function runMcpServer(
  argv: readonly string[],
  run: McpServerRun,
): Promise<number> {
  const { io, output, commands } = run;
  const options = parseOptions(argv);
  if ("usage" in options) {
    output.stderr(`mpu mcp: ${options.usage}\n`);
    return 2;
  }
  const port = options.port ?? await configuredPort(io);
  const token = await ensureAccessToken(io);
  await warnOnVersionMismatch(io, output);
  try {
    const server = await serveMcp({
      port,
      profiles: options.profiles,
      token,
      deps: { io: withoutStdin(io), commands, version: VERSION, log: run.log },
      signal: run.signal,
    });
    // Адрес печатается в stderr: stdout этой поверхности принадлежит
    // протоколу, и туда не должно попадать ничего постороннего.
    output.stderr(
      `mpu mcp: слушаю http://${LOOPBACK}:${server.port}` +
        ` (${options.profiles.map((profile) => `/${profile}`).join(", ")})\n`,
    );
    run.onListen?.(server);
    await server.finished;
    return 0;
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      output.stderr(`mpu mcp: порт ${port} занят\n`);
      return 1;
    }
    throw err;
  }
}

/**
 * Копящий приёмник вывода удалённой команды: у вызова тула потока к
 * агенту нет, поэтому вывод складывается в текст и уезжает полем
 * результата. Оба потока идут в один текст и в том порядке, в каком их
 * прислал транспорт, — как их увидел бы человек в терминале.
 */
function capturingRemoteOutput(): RemoteOutput {
  const parts: string[] = [];
  // Декодер на поток свой: он копит хвост оборванной UTF-8
  // последовательности, и один на двоих склеил бы хвост stdout с
  // началом stderr. Финальный `decode()` без данных дописывает
  // недобранный хвост последнего куска — без него он пропал бы.
  const out = new TextDecoder();
  const err = new TextDecoder();
  const append = (decoder: TextDecoder) => (chunk: Uint8Array) => {
    parts.push(decoder.decode(chunk, { stream: true }));
  };
  return {
    out: append(out),
    err: append(err),
    captured: () => `${parts.join("")}${out.decode()}${err.decode()}`,
  };
}

/**
 * Окружение вызова тула: stdin у него нет. Долгоживущий процесс делит
 * один stdin на все вызовы, и команда, читающая его (`mpu sql-ro` без
 * аргумента SQL), забрала бы поток сервера и повисла бы на нём. Отказ
 * называет, чем это чинится, — обычная ошибка ввода вместо зависания.
 */
function withoutStdin(io: CommandIo): CommandIo {
  return {
    ...io,
    readStdin: () =>
      Promise.reject(
        new UsageError("stdin у вызова тула нет — передай значение аргументом"),
      ),
    stdinIsTerminal: () => false,
    // Потока к агенту у тула нет: вывод удалённой команды копится и
    // уезжает полем результата, а не в stdout сервера. Приёмник свой на
    // каждый прогон — вызовы тулов идут вперемешку.
    openRemoteOutput: () => capturingRemoteOutput(),
  };
}

/**
 * Предупреждает, если установленная Python-реализация другой версии,
 * чем слепок, из которого собран реестр: описания тулов маршрута
 * `legacy` и однострокѝ справки берутся из слепка и в этом случае
 * врут. Сервер при этом поднимается — он полезен и так, а решать
 * пользователю.
 *
 * Спрашивается один раз при старте: сервер долгоживущий, и лишний
 * подпроцесс на каждый вызов тула был бы дороже пользы.
 */
async function warnOnVersionMismatch(
  io: StartupIo,
  output: ErrorSink,
): Promise<void> {
  const bin = await resolveLegacyBin(io);
  let installed: string;
  try {
    const outcome = await io.runLegacy(bin, ["version"]);
    if (outcome.code !== 0) return;
    installed = outcome.stdout;
  } catch (err) {
    // Реализации нет — это не повод не поднимать сервер: тулы
    // маршрута `legacy` откажут при вызове, с текстом спеки.
    if (err instanceof NotFoundIoError) return;
    throw err;
  }
  const problem = versionMismatch(installed);
  if (problem !== undefined) output.stderr(`mpu mcp: ${problem}\n`);
}

/** Разбор `--profile` и `--port`; всё прочее — ошибка ввода. */
function parseOptions(argv: readonly string[]): Options {
  let profiles: readonly Profile[] = ["ro", "rw"];
  let port: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const [name, inlineValue] = splitFlag(argv[index]);
    // Значение либо приклеено через «=», либо стоит следующим словом —
    // тогда оно и съедается шагом цикла.
    let value = inlineValue;
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (name === "--profile") {
      const parsed = parseProfiles(value);
      if (parsed === undefined) {
        return { usage: `значение --profile вне ro/rw: ${value ?? "(пусто)"}` };
      }
      profiles = parsed;
      continue;
    }
    if (name === "--port") {
      const parsed = parsePort(value);
      if (parsed === undefined) {
        return { usage: `значение --port не порт: ${value ?? "(пусто)"}` };
      }
      port = parsed;
      continue;
    }
    return { usage: `неизвестный флаг ${name}` };
  }
  return { profiles, port };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/** `ro`, `rw` или `ro,rw`; порядок нормализуется, дубликаты убираются. */
function parseProfiles(
  value: string | undefined,
): readonly Profile[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => part !== "ro" && part !== "rw")) return undefined;
  const wanted = new Set(parts);
  const profiles = (["ro", "rw"] as const).filter((profile) =>
    wanted.has(profile)
  );
  return profiles.length === 0 ? undefined : profiles;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 0 && port <= 65535 ? port : undefined;
}

/** Порт из конфига; ключа нет или он не порт — умолчание спеки. */
async function configuredPort(io: StartupIo): Promise<number> {
  const store = parseStore(await io.readConfigStore());
  return parsePort(store.values[PORT_KEY]) ?? DEFAULT_PORT;
}
