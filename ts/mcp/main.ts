/**
 * Точка входа переводчика `mpu-mcp` (`bun run mcp`): окружение
 * процесса → переводчик до сигнала → код.
 */

import { writeSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { VERSION } from "../back/src/version.ts";
import { type McpProcess, runMcp, type TokenFile } from "./src/mod.ts";

const DEFAULT_BACK_URL = "http://127.0.0.1:7338";
const encoder = new TextEncoder();

/** Полная запись в дескриптор: `writeSync` может записать часть. */
function write(fd: number, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes.subarray(written));
  }
}

function tokenFile(path: string): TokenFile {
  return {
    path,
    read: async () => {
      try {
        return (await readFile(path, "utf8")).trim();
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return undefined;
        }
        throw err;
      }
    },
    write: async (token) => {
      // Каталог создаёт `mpu-back` вместе с основным токеном; права —
      // только на сам файл, временного соседа не завести.
      await writeFile(path, `${token}\n`, { mode: 0o600 });
      // У существующего файла `mode` не применяется — права явно.
      await chmod(path, 0o600);
    },
  };
}

if (import.meta.main) {
  const stopped = Promise.withResolvers<void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => stopped.resolve());
  }
  const home = process.env.HOME ?? "";
  const proc: McpProcess = {
    backUrl: process.env.MPU_BACK_URL ?? DEFAULT_BACK_URL,
    backToken: tokenFile(`${home}/.config/mpu/token`),
    mcpToken: tokenFile(`${home}/.config/mpu/mcp-token`),
    cwd: home,
    version: VERSION,
    stdout: (text) => write(1, text),
    stderr: (text) => write(2, text),
    stopped: stopped.promise,
  };
  process.exit(await runMcp(process.argv.slice(2), proc));
}
