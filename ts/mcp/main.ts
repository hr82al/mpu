/**
 * Точка входа переводчика `mpu-mcp` (`deno task mcp`): окружение
 * процесса → переводчик до сигнала → код.
 */

import { type McpProcess, runMcp, type TokenFile } from "./src/mod.ts";

const DEFAULT_BACK_URL = "http://127.0.0.1:7338";
const VERSION = "0.1.0";
const encoder = new TextEncoder();

function write(file: { writeSync(p: Uint8Array): number }, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += file.writeSync(bytes.subarray(written));
  }
}

function tokenFile(path: string): TokenFile {
  return {
    path,
    read: async () => {
      try {
        return (await Deno.readTextFile(path)).trim();
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return undefined;
        throw err;
      }
    },
    write: async (token) => {
      // Каталог создаёт `mpu-back` вместе с основным токеном; права —
      // только на сам файл, временного соседа не завести.
      await Deno.writeTextFile(path, `${token}\n`, { mode: 0o600 });
      // У существующего файла `mode` не применяется — права явно.
      await Deno.chmod(path, 0o600);
    },
  };
}

if (import.meta.main) {
  const stopped = Promise.withResolvers<void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => stopped.resolve());
  }
  const home = Deno.env.get("HOME") ?? "";
  const proc: McpProcess = {
    backUrl: Deno.env.get("MPU_BACK_URL") ?? DEFAULT_BACK_URL,
    backToken: tokenFile(`${home}/.config/mpu/token`),
    mcpToken: tokenFile(`${home}/.config/mpu/mcp-token`),
    cwd: home,
    version: VERSION,
    stdout: (text) => write(Deno.stdout, text),
    stderr: (text) => write(Deno.stderr, text),
    stopped: stopped.promise,
  };
  Deno.exit(await runMcp(Deno.args, proc));
}
