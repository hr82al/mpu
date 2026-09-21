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
  stopUnit,
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
 * процесса: 2 — ошибка ввода, 1 — порт занят, уступаемую службу не
 * удалось остановить либо вернуть.
 *
 * Неудавшийся опрос менеджера при решении об уступке, в том числе
 * повторный непосредственно перед `stop`, — не отказ, а «выяснить не
 * удалось»: уступки нет. Отказ самой остановки называется в stderr:
 * сервер не поднимается, службу пробуют вернуть. Прерывание до остановки
 * отменяет и уступку, и прослушивание; во время остановки — только
 * прослушивание, служба возвращается. Отказ возврата любого рода
 * называется в stderr и даёт код 1; дефект своего кода всплывает.
 */
export async function runMcpServer(
  argv: readonly string[],
  run: McpServerRun,
): Promise<number> {
  const { io, output } = run;
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
    const taken = await borrowPort(run, port, stopping.signal);
    if (taken.kind !== "untouched") borrowed = taken.deps;
    if (taken.kind === "stopRefused") code = 1;
    // Прерывание, пришедшее до или во время остановки службы, отменяет
    // прослушивание: сервер, поднятый с уже отменённым сигналом, не гас
    // бы до второго сигнала, а тот убил бы процесс без возврата службы.
    else if (!stopping.signal.aborted) {
      code = await listen(run, options.profiles, port, token, stopping.signal);
    }
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

/** Слушает до гашения; 1 — порт занят. */
async function listen(
  run: McpServerRun,
  profiles: readonly Profile[],
  port: number,
  token: string,
  signal: AbortSignal,
): Promise<number> {
  const { io, output, commands } = run;
  try {
    const server = await serveMcp({
      port,
      profiles,
      token,
      deps: { io: withoutStdin(io), commands, version: VERSION, log: run.log },
      signal,
    });
    // Адрес печатается в stderr: stdout этой поверхности принадлежит
    // протоколу, и туда не должно попадать ничего постороннего.
    output.stderr(
      `mpu mcp: слушаю http://${LOOPBACK}:${server.port}` +
        ` (${profiles.map((profile) => `/${profile}`).join(", ")})\n`,
    );
    run.onListen?.(server);
    await server.finished;
    return 0;
  } catch (err) {
    if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    output.stderr(`mpu mcp: порт ${port} занят\n`);
    return 1;
  }
}

/**
 * Чем кончилась попытка взять порт у службы: не трогали, уступила или
 * остановить не удалось. В двух последних службу по выходе возвращают:
 * после отказавшего `stop` она могла погаснуть.
 */
type Taken =
  | { readonly kind: "untouched" }
  | { readonly kind: "yielded"; readonly deps: ServiceDeps }
  | { readonly kind: "stopRefused"; readonly deps: ServiceDeps };

const UNTOUCHED: Taken = { kind: "untouched" };

/**
 * Порт под передний план: работающая служба его уступает, а по выходе
 * получает обратно. «Не трогали» — после выхода не запускается ничего:
 * заводить службу, которой не было, команда не должна.
 *
 * Порт, заданный флагом не тем, на котором стоит служба, уступки не
 * требует: занят он не ею. Прерывание, пришедшее до остановки, уступку
 * отменяет.
 *
 * @param signal гашение запуска: отменён к моменту `stop` — службу не трогаем
 */
async function borrowPort(
  run: McpServerRun,
  port: number,
  signal: AbortSignal,
): Promise<Taken> {
  if (port !== configuredPort(run.io)) return UNTOUCHED;
  const deps = serviceDepsIfAny(run.io, run.service);
  if (deps === undefined) return UNTOUCHED;
  if (!await askRunning(deps)) return UNTOUCHED;
  // Юнит запускает тот же голый `mpu mcp`: уступив порт себе, служба
  // останавливает саму себя и не поднимается вовсе. Не уступаем и
  // тогда, когда выяснить не удалось, — цена ошибки несимметрична: в
  // одну сторону поверхность мертва, в другую передний план печатает
  // «порт занят», как до этой спеки.
  const main = await askManager(() => servicePid(deps));
  if (main === undefined || main === Deno.pid) return UNTOUCHED;
  // Между первым вопросом о состоянии и ответом о главном процессе службу
  // мог погасить кто-то ещё: тогда уступать нечего, а запустить её после
  // себя значило бы поднять то, что стояло.
  if (!await askRunning(deps)) return UNTOUCHED;
  // Прерывание до остановки — во время любого из опросов выше или ещё до
  // них: остановить живую службу, чтобы тут же поднять её снова, —
  // перезапуск впустую; уступки нет.
  if (signal.aborted) return UNTOUCHED;
  try {
    await stopUnit(deps);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    run.output.stderr(
      `mpu mcp: остановить службу не удалось: ${err.message}\n`,
    );
    return { kind: "stopRefused", deps };
  }
  // С машиной владельца делается заметное, и он должен это видеть. После
  // `stop` менеджер не перечитывается: отказ перечитывания унёс бы факт
  // остановки, и служба осталась бы лежать без попытки возврата.
  run.output.stderr(
    `mpu mcp: служба ${SERVICE_NAME} остановлена, порт ${port} уступлен ей\n`,
  );
  return { kind: "yielded", deps };
}

/**
 * Описана ли служба и работает ли, по ответу менеджера; спросить не
 * удалось — «нет». Описание проверяется до всякого обращения к менеджеру:
 * неописанную службу уступать не за что.
 */
async function askRunning(deps: ServiceDeps): Promise<boolean> {
  const state = await askManager(() => readServiceState(deps));
  return state !== undefined && state.program !== null &&
    isRunning(state.activity);
}

/**
 * Ответ менеджера на вопрос об уступке; спросить не удалось — `undefined`.
 * Опрос — вопрос, а не действие: нет права на запуск, `systemctl` не
 * найден (`DomainError` слоя службы) или нет прав на чтение описания — значит,
 * выяснить не удалось, и уступки нет, сервер поднимается как раньше
 * (`mcp-service.md`, «Граничные случаи и ошибки»). Дефект своего кода к
 * этим отказам не относится и всплывает.
 */
async function askManager<T>(
  question: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await question();
  } catch (err) {
    if (isRefusal(err)) return undefined;
    throw err;
  }
}

/**
 * Отказ менеджера или окружения, а не дефект своего кода: `DomainError`
 * слоя службы (в том числе «`systemctl` не найден»), нет права на запуск,
 * нет прав на чтение описания. Один набор на опрос и на возврат службы:
 * разойдясь, они по-разному называли бы одно и то же.
 */
function isRefusal(err: unknown): err is Error {
  return err instanceof DomainError ||
    err instanceof Deno.errors.NotCapable ||
    err instanceof Deno.errors.PermissionDenied;
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
    // Отказ любого рода — ответ менеджера кодом, нет права на запуск, нет
    // прав на чтение описания — ожидаемый исход; дефект собственного кода
    // отказом службы притворяться не должен.
    if (!isRefusal(err)) throw err;
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
  // Накопитель готов принять следующий кусок всегда: он копит в
  // памяти вызова, и притормаживать печатающего нечем.
  const append = (decoder: TextDecoder) => (chunk: Uint8Array) => {
    parts.push(decoder.decode(chunk, { stream: true }));
    return Promise.resolve();
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
