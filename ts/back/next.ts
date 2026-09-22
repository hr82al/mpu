/**
 * Точка входа `mpu-next` (`deno task next`): та же склейка процесса, что
 * у `main.ts`, с исполнением строки цепочкой сообщений. В бинарь не
 * собирается.
 */

import {
  immediately,
  nextEntry,
  policyFile,
  terminalChannel,
} from "./src/next/mod.ts";
import { runProcess } from "./src/process/mod.ts";
import { defaultStateDir } from "./src/runtime/mod.ts";

/**
 * Одна строка ответа человека со stdin процесса: вопрос правил
 * подтверждения (`platform/policy.md`, «Канал вызова»). Живёт здесь, у
 * своего единственного вызывающего: у клиента ответ читается с
 * управляющего терминала, а не со stdin (`cli-client.md`).
 */
async function readStdinLine(): Promise<string | undefined> {
  const bytes: number[] = [];
  const chunk = new Uint8Array(1);
  while (true) {
    const read = await Deno.stdin.read(chunk);
    if (read === null) break;
    if (read === 0) continue;
    if (chunk[0] === 0x0a) {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    bytes.push(chunk[0]);
  }
  return bytes.length === 0
    ? undefined
    : new TextDecoder().decode(new Uint8Array(bytes));
}

if (import.meta.main) {
  const ports = {
    file: policyFile(defaultStateDir()),
    channel: terminalChannel(readStdinLine),
    execute: immediately,
    rootMethods: [],
  };
  Deno.exit(await runProcess(Deno.args, nextEntry(ports)));
}
