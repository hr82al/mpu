/**
 * Точка входа тонкого клиента `mpu` (`deno task cli`): окружение
 * процесса → строка на сервере → код.
 */

import { copyToClipboard } from "./src/clipboard/mod.ts";
import type { CallerFacts } from "../back/src/frames/mod.ts";
import { openControllingTerminal } from "./src/terminal/mod.ts";
import { createInterface } from "node:readline";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { SESSION_ENV } from "../back/src/frames/mod.ts";
import { CHANNEL_WORDS, runChannel } from "./src/channel/mod.ts";
import { type ClientEnv, runClient } from "./src/mod.ts";

const DEFAULT_URL = "http://127.0.0.1:7338";
const encoder = new TextEncoder();

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

/**
 * Весь stdin байтами. Зовётся только по запросу строки и только когда
 * stdin не терминал (`platform/stdin-on-request.md`).
 */
async function readStdin(): Promise<Uint8Array> {
  return new Uint8Array(await new Response(Deno.stdin.readable).arrayBuffer());
}

/** Ширина консоли клиента; консоли нет — ширины нет. */
function consoleColumns(): number | undefined {
  try {
    return Deno.consoleSize().columns;
  } catch {
    // Консоли нет (терминал исчез между проверкой и запросом) —
    // ограничения вывода тоже нет.
    return undefined;
  }
}

if (import.meta.main) {
  const interrupted = Promise.withResolvers<void>();
  Deno.addSignalListener("SIGINT", () => interrupted.resolve());
  const config = `${Deno.env.get("HOME") ?? "$HOME"}/.config/mpu`;
  // Контекст вызова снимается только здесь: ниже клиент о своих
  // потоках и переменных не спрашивает (`platform/call-context.md`).
  const caller: CallerFacts = {
    stdin: readStdin,
    stdinIsTerminal: () => Deno.stdin.isTerminal(),
    stdoutIsTerminal: () => Deno.stdout.isTerminal(),
    stderrIsTerminal: () => Deno.stderr.isTerminal(),
    columns: consoleColumns,
    value: (name) => Deno.env.get(name),
  };
  const env: ClientEnv = {
    base: Deno.env.get("MPU_BACK_URL") ?? DEFAULT_URL,
    mainTokenPath: `${config}/token`,
    mainToken: () => tokenAt(`${config}/token`),
    agentToken: () => tokenAt(`${config}/agent-token`),
    caller,
    // Родитель — оболочка терминала: у человека он стоит, пока открыт
    // терминал; права не нужны (`platform/it.md`).
    name: `ppid:${Deno.ppid}`,
    openTerminal: openControllingTerminal,
    copy: (text) => copyToClipboard(text),
    stdout: (text) => writeAll(Deno.stdout, text),
    stderr: (text) => writeAll(Deno.stderr, text),
    cwd: () => Deno.cwd(),
    interrupted: interrupted.promise,
  };
  // Канал Claude Code — не строка ядра: живёт, пока открыт stdin
  // (`claude-channel.md`). Склейка — на `node:*` (`ts/CLAUDE.md`,
  // «Библиотеки и приёмы»).
  const channel = Deno.args.length === CHANNEL_WORDS.length &&
    Deno.args.every((word, i) => word === CHANNEL_WORDS[i]);
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
  Deno.exit(await runClient(Deno.args, env));
}
