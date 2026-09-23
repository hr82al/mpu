/**
 * Процесс `mpu-back` (`platform/back-rpc.md`, «CLI-контракт»): разбор
 * `--port`, `--lines` (`platform/line-concurrency.md`) и `--worker`
 * (`platform/line-executor.md`), токен, сервер до сигнала остановки.
 */

import type { CommandIo } from "../command/mod.ts";
import type { Output } from "../entrypoint/mod.ts";
import type { InvokeLog } from "../invokelog/mod.ts";
import { ensureAccessToken } from "../mcp/mod.ts";
import { VERSION } from "../version.ts";
import type { SecretText } from "../runtime/mod.ts";
import { DEFAULT_LINES } from "./limit.ts";
import { DEFAULT_BACK_PORT, serveBack } from "./server.ts";
import { WebAccess } from "./web.ts";
import type { Launcher, Markers } from "../worker/mod.ts";

/** Чтение и запись файла токена. */
type TokenIo = Pick<CommandIo, "readAccessToken" | "writeAccessToken">;

const USAGE = "mpu-back: использование: deno task back [--port <число>] " +
  "[--lines <число>] [--worker <путь>]\n";

/** Отказ запуска: предел строк назван, но негоден (`--lines 0`). */
const BAD_LINES = "mpu-back: предел строк должен быть больше нуля\n";

/** Что процессу нужно снаружи. */
export interface BackProcess {
  /** Окружение; его `readAccessToken`/`writeAccessToken` — основной токен. */
  readonly io: CommandIo;
  /** Файл агентского токена (`cli-client.md`, «Канал и токен»). */
  readonly agentToken: TokenIo;
  readonly log: InvokeLog;
  /** Файл правил подтверждения; нет HOME — `undefined`. */
  readonly policyFile: string | undefined;
  /** Файл образа (`platform/image.md`); нет HOME — `undefined`. */
  readonly imageFile: string | undefined;
  /** Файл снимка дерева; нет HOME — `undefined`. */
  readonly snapshotFile: string | undefined;
  /** Файл сессий входа в браузере (`web-sessions`, 0600). */
  readonly webSessions: SecretText;
  /** Каталог собранного фронта. */
  readonly webRoot: string;
  readonly output: Output;
  /** Завершается по SIGTERM или SIGINT. */
  readonly stopped: Promise<void>;
  /**
   * Исполнители строк (`platform/line-executor.md`): программа по
   * умолчанию (`mpu-worker` рядом с `mpu-back`), как запускать программу,
   * названную `--worker`, и отметки сторожа.
   */
  readonly workers: {
    readonly program: string;
    readonly launcher: (program: string) => Launcher;
    readonly markers: Markers;
  };
}

/** С чем поднимать сервер либо готовый отказ в stderr. */
type Startup =
  | {
    readonly port: number;
    readonly lines: number;
    /** Программа исполнителя из `--worker`; не названа — умолчание. */
    readonly worker?: string;
  }
  | { readonly refusal: string };

/** Целое из значения флага; не целое — `undefined`. */
function integerOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

/**
 * Разбор аргументов: пары `--port`/`--lines`/`--worker` в любом порядке. «Не
 * число» — ошибка формы вызова (строка использования), «число, но не
 * годится» — названный отказ (`platform/line-concurrency.md`).
 */
function startupOf(args: readonly string[]): Startup {
  let port = DEFAULT_BACK_PORT;
  let lines = DEFAULT_LINES;
  let worker: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    // Путь — не число: его значение не разбирается, лишь бы было.
    if (args[index] === "--worker" && args[index + 1] !== undefined) {
      worker = args[index + 1];
      continue;
    }
    const value = integerOf(args[index + 1]);
    if (value === undefined) return { refusal: USAGE };
    if (args[index] === "--port") {
      if (value < 0 || value > 65535) return { refusal: USAGE };
      port = value;
      continue;
    }
    if (args[index] === "--lines") {
      if (value <= 0) return { refusal: BAD_LINES };
      lines = value;
      continue;
    }
    return { refusal: USAGE };
  }
  return { port, lines, worker };
}

/**
 * Исполняет процесс `mpu-back` и возвращает код завершения.
 *
 * @param args аргументы процесса
 * @param proc окружение процесса
 */
export async function runBack(
  args: readonly string[],
  proc: BackProcess,
): Promise<number> {
  if (args.length === 1 && args[0] === "--version") {
    proc.output.stdout(`${VERSION}\n`);
    return 0;
  }
  const startup = startupOf(args);
  if ("refusal" in startup) {
    proc.output.stderr(startup.refusal);
    return 2;
  }
  const { port, lines } = startup;
  const workers = proc.workers;
  let running;
  try {
    running = await serveBack({
      port,
      lines,
      // Оба токена создаёт сервер при старте; клиент файлов не пишет.
      tokens: {
        main: await ensureAccessToken(proc.io),
        agent: await ensureAccessToken(proc.agentToken),
      },
      policyFile: proc.policyFile,
      imageFile: proc.imageFile,
      io: proc.io,
      log: proc.log,
      snapshotFile: proc.snapshotFile,
      web: await WebAccess.open({
        file: proc.webSessions,
        now: () => Date.now(),
      }),
      webRoot: proc.webRoot,
      diagnose: (line) => proc.output.stderr(`${line}\n`),
      workers: {
        launcher: workers.launcher(startup.worker ?? workers.program),
        markers: workers.markers,
      },
    });
  } catch (err) {
    if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    proc.output.stderr(`mpu-back: порт ${port} занят\n`);
    return 1;
  }
  proc.output.stdout(`mpu-back: http://${running.hostname}:${running.port}\n`);
  await proc.stopped;
  await running.stop();
  return 0;
}
