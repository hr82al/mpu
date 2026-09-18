/**
 * Процесс `mpu-back` (`platform/back-rpc.md`, «CLI-контракт»): разбор
 * `--port`, токен, сервер до сигнала остановки.
 */

import type { CommandIo } from "../command/mod.ts";
import type { Output } from "../entrypoint/mod.ts";
import type { InvokeLog } from "../invokelog/mod.ts";
import { ensureAccessToken } from "../mcp/mod.ts";
import { DEFAULT_BACK_PORT, serveBack } from "./server.ts";

/** Чтение и запись файла токена. */
type TokenIo = Pick<CommandIo, "readAccessToken" | "writeAccessToken">;

const USAGE = "mpu-back: использование: deno task back [--port <число>]\n";

/** Что процессу нужно снаружи. */
export interface BackProcess {
  /** Окружение; его `readAccessToken`/`writeAccessToken` — основной токен. */
  readonly io: CommandIo;
  /** Файл агентского токена (`cli-client.md`, «Канал и токен»). */
  readonly agentToken: TokenIo;
  readonly log: InvokeLog;
  /** Файл правил подтверждения; нет HOME — `undefined`. */
  readonly policyFile: string | undefined;
  /** Файл снимка дерева; нет HOME — `undefined`. */
  readonly snapshotFile: string | undefined;
  readonly output: Output;
  /** Завершается по SIGTERM или SIGINT. */
  readonly stopped: Promise<void>;
}

/** Порт из аргументов; не разобрался — `undefined`. */
function portOf(args: readonly string[]): number | undefined {
  if (args.length === 0) return DEFAULT_BACK_PORT;
  if (args.length !== 2 || args[0] !== "--port") return undefined;
  const port = Number(args[1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return port;
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
  const port = portOf(args);
  if (port === undefined) {
    proc.output.stderr(USAGE);
    return 2;
  }
  let running;
  try {
    running = await serveBack({
      port,
      // Оба токена создаёт сервер при старте; клиент файлов не пишет.
      tokens: {
        main: await ensureAccessToken(proc.io),
        agent: await ensureAccessToken(proc.agentToken),
      },
      policyFile: proc.policyFile,
      io: proc.io,
      log: proc.log,
      snapshotFile: proc.snapshotFile,
      diagnose: (line) => proc.output.stderr(`${line}\n`),
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
