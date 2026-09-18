/**
 * Процесс `mpu-mcp` (`platform/mcp-objects.md`, «CLI-контракт»): разбор
 * `--port`, токены, переводчик до сигнала остановки.
 */

import { BackLine } from "./back.ts";
import { serveMcp } from "./server.ts";

/** Порт по умолчанию: рядом с `mpu mcp` (7337) и `mpu-back` (7338). */
export const DEFAULT_MCP_PORT = 7339;

const USAGE = "mpu-mcp: использование: deno task mcp [--port <число>]\n";

/** Файл токена: чтение и создание. */
export interface TokenFile {
  readonly path: string;
  /** Токен; нет файла — `undefined`. */
  read(): Promise<string | undefined>;
  /** Запись нового токена с правами 0600. */
  write(token: string): Promise<void>;
}

/** Что процессу нужно снаружи. */
export interface McpProcess {
  /** Адрес `mpu-back`. */
  readonly backUrl: string;
  /** Основной токен `back` — только чтение. */
  readonly backToken: TokenFile;
  /** Токен клиента MCP — создаётся, если нет. */
  readonly mcpToken: TokenFile;
  /** Каталог строк (домашний). */
  readonly cwd: string;
  readonly version: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Завершается по SIGTERM или SIGINT. */
  readonly stopped: Promise<void>;
}

/** Порт из аргументов; не разобрался — `undefined`. */
function portOf(args: readonly string[]): number | undefined {
  if (args.length === 0) return DEFAULT_MCP_PORT;
  if (args.length !== 2 || args[0] !== "--port") return undefined;
  const port = Number(args[1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return port;
}

/** Случайный токен: 256 бит, base64url без выравнивания. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function ensured(file: TokenFile): Promise<string> {
  const existing = await file.read();
  if (existing !== undefined && existing !== "") return existing;
  const token = newToken();
  await file.write(token);
  return token;
}

/**
 * Исполняет процесс `mpu-mcp` и возвращает код завершения.
 *
 * @param args аргументы процесса
 * @param proc окружение процесса
 */
export async function runMcp(
  args: readonly string[],
  proc: McpProcess,
): Promise<number> {
  if (args.length === 1 && args[0] === "--version") {
    proc.stdout(`${proc.version}\n`);
    return 0;
  }
  const port = portOf(args);
  if (port === undefined) {
    proc.stderr(USAGE);
    return 2;
  }
  const backToken = await proc.backToken.read();
  if (backToken === undefined || backToken === "") {
    proc.stderr(`mpu-mcp: нет токена mpu-back (${proc.backToken.path})\n`);
    return 1;
  }
  const token = await ensured(proc.mcpToken);
  let running;
  try {
    running = await serveMcp({
      port,
      token,
      version: proc.version,
      back: new BackLine({
        base: proc.backUrl,
        token: backToken,
        cwd: proc.cwd,
      }),
    });
  } catch (err) {
    if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    proc.stderr(`mpu-mcp: порт ${port} занят\n`);
    return 1;
  }
  proc.stdout(`mpu-mcp: http://${running.hostname}:${running.port}/mcp\n`);
  await proc.stopped;
  await running.stop();
  return 0;
}
