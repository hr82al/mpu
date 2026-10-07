/**
 * Точка входа тонкого клиента `mpu` (`deno task cli`): окружение
 * процесса → строка на сервере → код.
 */

import { copyToClipboard } from "./src/clipboard/mod.ts";
import type { CallerFacts } from "../back/src/frames/mod.ts";
import { openControllingTerminal } from "./src/terminal/mod.ts";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import process from "node:process";
import { buffer } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { isatty } from "node:tty";
import { SESSION_ENV } from "../back/src/frames/mod.ts";
import { CHANNEL_WORDS, runChannel } from "./src/channel/mod.ts";
import { type ClientEnv, runClient } from "./src/mod.ts";

const DEFAULT_URL = "http://127.0.0.1:7338";
const encoder = new TextEncoder();

/** Полная запись в дескриптор: `writeSync` может записать часть. */
function writeAll(fd: number, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes.subarray(written));
  }
}

/** Токен из файла; нет файла, нет права или пусто — не читается. */
async function tokenAt(path: string): Promise<string | undefined> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    return token === "" ? undefined : token;
  } catch {
    // «Нет файла» и «нет права на чтение» для клиента одно: этим
    // токеном он не ходит (`cli-client.md`, «Канал и токен»).
    return undefined;
  }
}

/**
 * Весь stdin байтами. Зовётся только по запросу строки и только когда
 * stdin не терминал (`platform/stdin-on-request.md`).
 */
async function readStdin(): Promise<Uint8Array> {
  return new Uint8Array(await buffer(process.stdin));
}

/**
 * Ширина консоли клиента; консоли нет — ширины нет. Спрашивается, только
 * когда stdout — терминал (`contextFieldsOf`).
 */
function consoleColumns(): number | undefined {
  return process.stdout.columns;
}

if (import.meta.main) {
  const interrupted = Promise.withResolvers<void>();
  process.on("SIGINT", () => interrupted.resolve());
  const config = `${process.env.HOME ?? "$HOME"}/.config/mpu`;
  // Контекст вызова снимается только здесь: ниже клиент о своих
  // потоках и переменных не спрашивает (`platform/call-context.md`).
  const caller: CallerFacts = {
    stdin: readStdin,
    stdinIsTerminal: () => isatty(0),
    stdoutIsTerminal: () => isatty(1),
    stderrIsTerminal: () => isatty(2),
    columns: consoleColumns,
    value: (name) => process.env[name],
  };
  const env: ClientEnv = {
    base: process.env.MPU_BACK_URL ?? DEFAULT_URL,
    mainTokenPath: `${config}/token`,
    mainToken: () => tokenAt(`${config}/token`),
    agentToken: () => tokenAt(`${config}/agent-token`),
    caller,
    // Родитель — оболочка терминала: у человека он стоит, пока открыт
    // терминал; права не нужны (`platform/it.md`).
    name: `ppid:${process.ppid}`,
    openTerminal: openControllingTerminal,
    copy: (text) => copyToClipboard(text),
    stdout: (text) => writeAll(1, text),
    stderr: (text) => writeAll(2, text),
    cwd: () => process.cwd(),
    interrupted: interrupted.promise,
  };
  // Канал Claude Code — не строка ядра: живёт, пока открыт stdin
  // (`claude-channel.md`). Склейка — на `node:*` (`ts/CLAUDE.md`,
  // «Библиотеки и приёмы»).
  const args = process.argv.slice(2);
  const channel = args.length === CHANNEL_WORDS.length &&
    args.every((word, i) => word === CHANNEL_WORDS[i]);
  if (channel) {
    process.exit(
      await runChannel({
        base: env.base,
        mainToken: env.mainToken,
        key: process.env[SESSION_ENV],
        lines: createInterface({ input: process.stdin, crlfDelay: Infinity }),
        write: (text) =>
          new Promise((resolve, reject) =>
            process.stdout.write(text, (err) => err ? reject(err) : resolve())
          ),
        stderr: (text) => void process.stderr.write(text),
        pause: (ms, signal) => sleep(ms, undefined, { signal }),
      }),
    );
  }
  process.exit(await runClient(args, env));
}
