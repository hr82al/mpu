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
  DomainError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import { configValue, readPreferences } from "../config/mod.ts";
import type { Profile } from "./mod.ts";
import {
  DEFAULT_PORT,
  LOOPBACK,
  type RunningServer,
  serveMcp,
} from "./server.ts";
import { ensureAccessToken } from "./token.ts";
import {
  isRunning,
  readServiceState,
  SERVICE_NAME,
  type ServiceDeps,
  serviceDepsIfAny,
  type ServiceOptions,
  servicePid,
  startService,
  stopService,
} from "./service.ts";
import { VERSION } from "../version.ts";
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
  /**
   * Менеджер службы: у кого просить порт и кому его возвращать.
   * Умолчание — настоящий; тесты подставляют своего, потому что в
   * прогоне тестов менеджера служб пользователя нет.
   */
  readonly service?: ServiceOptions;
  /**
   * Подписка на сигналы завершения; возвращает способ отписаться.
   * Шов, а не прямой `Deno.addSignalListener`: проверять возврат службы
   * настоящим сигналом значило бы слать его собственному прогону
   * тестов.
   */
  readonly onInterrupt?: (handle: () => void) => () => void;
}

/**
 * Настоящая подписка на прерывание с клавиатуры и сигнал завершения.
 * Своя обработка отменяет умолчание Deno «убить процесс», и это ровно
 * то, что нужно: возврат службы обязан пережить оба.
 */
function listenForInterrupt(handle: () => void): () => void {
  const signals: readonly Deno.Signal[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, handle);
  return () => {
    for (const signal of signals) Deno.removeSignalListener(signal, handle);
  };
}

/** Ключ конфига с портом по умолчанию (`platform/config.md`). */
const PORT_KEY = "mcp.port";

/**
 * Профили без флага `--profile`. Служба запускает сервер без флагов
 * (`docs/specs/mcp-service.md`), и её `status` называет ровно эти.
 */
export const DEFAULT_PROFILES: readonly Profile[] = ["ro", "rw"];

/** Разобранные флаги запуска; ошибка ввода — текст для stderr. */
type Options =
  | { readonly profiles: readonly Profile[]; readonly port: number | undefined }
  | { readonly usage: string };

/**
 * Срез порта для шага запуска, который его потребляет: порт из
 * конфига. Сам сервер получает порт целиком — он раздаёт его
 * произвольным командам.
 */
export type StartupIo = Pick<CommandIo, "env" | "openCacheDb">;

/**
 * Поднимает сервер и ждёт его остановки. Возвращает код завершения
 * процесса: 2 — ошибка ввода, 1 — порт занят либо уступившую службу не
 * удалось вернуть.
 *
 * Отказ менеджера службы при уступке порта бросается `DomainError`:
 * передний план в этом случае не поднимался, и делать вид, что вызов
 * состоялся, не за что.
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
  const port = options.port ?? configuredPort(io);
  const token = await ensureAccessToken(io);
  // Гашение сервера — одна точка на все способы закончить: штатный
  // конец, сигнал извне и прерывание с клавиатуры.
  const stopping = new AbortController();
  let subscribed: (() => void) | undefined;
  const unlisten = () => {
    subscribed?.();
    subscribed = undefined;
  };
  // Первый сигнал гасит штатно — со всем, что положено сделать по
  // дороге; второй убивает, как убивал до этой спеки: подписка
  // снимается здесь же. Иначе зависший вызов тула нечем снять, кроме
  // `SIGKILL`, — `Deno.serve` при отмене ждёт запросы в полёте.
  const stop = () => {
    unlisten();
    stopping.abort();
  };
  run.signal?.addEventListener("abort", stop);
  if (run.signal?.aborted) stop();
  // Подписка ставится ДО уступки: окно, в котором служба остановлена,
  // начинается внутри `borrowPort` — прерывание во время `systemctl
  // stop` иначе убило бы процесс умолчанием Deno и оставило бы службу
  // лежать. Безусловно, а не только при уступке: сервер, убитый
  // сигналом, выходит ненулевым кодом (замер 2026-09-09: 143 на
  // SIGTERM, 130 на SIGINT), и менеджер служб видел бы `failed` там,
  // где мы напечатали «остановлена».
  subscribed = (run.onInterrupt ?? listenForInterrupt)(stop);
  let borrowed: ServiceDeps | undefined;
  let code = 0;
  try {
    borrowed = await borrowPort(run, port);
    const server = await serveMcp({
      port,
      profiles: options.profiles,
      token,
      deps: { io: withoutStdin(io), commands, version: VERSION, log: run.log },
      signal: stopping.signal,
    });
    // Адрес печатается в stderr: stdout этой поверхности принадлежит
    // протоколу, и туда не должно попадать ничего постороннего.
    output.stderr(
      `mpu mcp: слушаю http://${LOOPBACK}:${server.port}` +
        ` (${options.profiles.map((profile) => `/${profile}`).join(", ")})\n`,
    );
    run.onListen?.(server);
    await server.finished;
  } catch (err) {
    if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    output.stderr(`mpu mcp: порт ${port} занят\n`);
    code = 1;
  } finally {
    // Возврат службы — до снятия подписок: пока он идёт, окно ещё
    // открыто. Снятие при этом безусловно, даже если возврат отказал
    // не по-доменному, — иначе обработчики сигналов пережили бы вызов.
    try {
      if (borrowed !== undefined && !await returnPort(run, borrowed)) code = 1;
    } finally {
      unlisten();
      run.signal?.removeEventListener("abort", stop);
    }
  }
  return code;
}

/**
 * Порт под передний план: работающая служба его уступает, а по выходе
 * получает обратно. Отвечает тем, у кого порт взят; `undefined` —
 * «трогать нечего», и после выхода не запускается ничего: заводить
 * службу, которой не было, команда не должна.
 *
 * Порт, заданный флагом не тем, на котором стоит служба, уступки не
 * требует: занят он не ею.
 */
async function borrowPort(
  run: McpServerRun,
  port: number,
): Promise<ServiceDeps | undefined> {
  if (port !== configuredPort(run.io)) return undefined;
  const deps = serviceDepsIfAny(run.io, run.service);
  if (deps === undefined) return undefined;
  // Проверка описания — до всякого обращения к менеджеру: на
  // неописанной службе `stopService` отказал бы, а отказывать здесь
  // не за что.
  const state = await readServiceState(deps);
  if (state.program === null || !isRunning(state.activity)) return undefined;
  // Юнит запускает тот же голый `mpu mcp`: уступив порт себе, служба
  // останавливает саму себя и не поднимается вовсе. Не уступаем и
  // тогда, когда выяснить не удалось, — цена ошибки несимметрична: в
  // одну сторону поверхность мертва, в другую передний план печатает
  // «порт занят», как до этой спеки.
  const main = await servicePid(deps);
  if (main === undefined || main === Deno.pid) return undefined;
  // Останавливала ли служба именно эта команда, знает сама остановка:
  // между вопросом о состоянии и ответом менеджера службу мог погасить
  // кто-то ещё, и тогда уступать было нечего — а запустить её после
  // себя значило бы поднять то, что стояло.
  if (!(await stopService(deps)).changed) return undefined;
  // С машиной владельца делается заметное, и он должен это видеть.
  run.output.stderr(
    `mpu mcp: служба ${SERVICE_NAME} остановлена, порт ${port} уступлен ей\n`,
  );
  return deps;
}

/**
 * Возврат службы на место. Отказ не бросается наружу: передний план к
 * этому моменту уже отработал, и прятать его итог за отказом менеджера
 * нечестно, — вместо этого называется, чем вернуть службу руками.
 *
 * @returns удалось ли вернуть
 */
async function returnPort(
  run: McpServerRun,
  deps: ServiceDeps,
): Promise<boolean> {
  let started: boolean;
  try {
    started = (await startService(deps)).changed;
  } catch (err) {
    // Отказ менеджера — ожидаемый исход; дефект собственного кода
    // отказом службы притворяться не должен.
    if (!(err instanceof DomainError)) throw err;
    // Что делать дальше, называет `status`, а не готовая команда: сам
    // отказ уже мог назвать свою (снятое описание советует `enable`), и
    // два разных совета в двух соседних строках обманывают читателя.
    run.output.stderr(
      `mpu mcp: службу ${SERVICE_NAME} вернуть не удалось: ${err.message}\n` +
        "mpu mcp: что с ней теперь — `mpu mcp status`\n",
    );
    return false;
  }
  run.output.stderr(
    started
      ? `mpu mcp: служба ${SERVICE_NAME} запущена снова\n`
      : `mpu mcp: служба ${SERVICE_NAME} уже работала — возвращать нечего\n`,
  );
  return true;
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

/** Разбор `--profile` и `--port`; всё прочее — ошибка ввода. */
function parseOptions(argv: readonly string[]): Options {
  let profiles: readonly Profile[] = DEFAULT_PROFILES;
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

/**
 * Порт из предпочтений; ключа нет или он не порт — умолчание спеки.
 * Экспортирован ради семейства службы (`service.ts`): адрес, который
 * печатают `enable` и `status`, обязан совпадать с тем, на котором
 * сервер поднимется, а второй способ его вычислить разошёлся бы с этим.
 */
export function configuredPort(io: StartupIo): number {
  const configured = readPreferences(
    io,
    (db) => configValue(db, PORT_KEY),
    undefined,
  );
  return parsePort(configured) ?? DEFAULT_PORT;
}
