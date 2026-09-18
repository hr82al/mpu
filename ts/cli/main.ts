/**
 * Точка входа тонкого клиента `mpu-next` (`deno task cli`): окружение
 * процесса → строка на сервере → код.
 */

import { type ClientEnv, runClient } from "./src/mod.ts";

const DEFAULT_URL = "http://127.0.0.1:7338";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeAll(file: { writeSync(p: Uint8Array): number }, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += file.writeSync(bytes.subarray(written));
  }
}

/** Токен из файла; нет файла, нет права или пусто — не читается. */
async function tokenAt(path: string): Promise<string | undefined> {
  try {
    const token = (await Deno.readTextFile(path)).trim();
    return token === "" ? undefined : token;
  } catch {
    // «Нет файла» и «нет права на чтение» для клиента одно: этим
    // токеном он не ходит (`cli-client.md`, «Канал и токен»).
    return undefined;
  }
}

/** Строка stdin побайтно: лишнего из терминала не забирать. */
async function readLine(): Promise<string | undefined> {
  const bytes: number[] = [];
  const chunk = new Uint8Array(1);
  while (true) {
    const read = await Deno.stdin.read(chunk);
    if (read === null) break;
    if (read === 0) continue;
    if (chunk[0] === 0x0a) return decoder.decode(new Uint8Array(bytes));
    bytes.push(chunk[0]);
  }
  return bytes.length === 0 ? undefined : decoder.decode(new Uint8Array(bytes));
}

if (import.meta.main) {
  const interrupted = Promise.withResolvers<void>();
  Deno.addSignalListener("SIGINT", () => interrupted.resolve());
  const config = `${Deno.env.get("HOME") ?? "$HOME"}/.config/mpu`;
  const env: ClientEnv = {
    base: Deno.env.get("MPU_BACK_URL") ?? DEFAULT_URL,
    mainTokenPath: `${config}/token`,
    mainToken: () => tokenAt(`${config}/token`),
    agentToken: () => tokenAt(`${config}/agent-token`),
    terminals: Deno.stdin.isTerminal() && Deno.stderr.isTerminal(),
    readLine,
    stdout: (text) => writeAll(Deno.stdout, text),
    stderr: (text) => writeAll(Deno.stderr, text),
    cwd: () => Deno.cwd(),
    interrupted: interrupted.promise,
  };
  Deno.exit(await runClient(Deno.args, env));
}
