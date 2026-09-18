/**
 * Точка входа `mpu-complete` (`deno task complete`): дополнение строки
 * `mpu-next` из снимка дерева. Ни сети, ни токенов, ни записи.
 */

import { runComplete } from "./src/mod.ts";

const encoder = new TextEncoder();

function write(file: { writeSync(p: Uint8Array): number }, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += file.writeSync(bytes.subarray(written));
  }
}

if (import.meta.main) {
  Deno.exit(
    await runComplete(Deno.args, {
      snapshotPath: `${Deno.env.get("HOME") ?? ""}/.cache/mpu/tree.json`,
      read: async (path) => {
        try {
          return await Deno.readTextFile(path);
        } catch {
          // Нет снимка, нет права, не файл — дополнять нечем, и это не
          // ошибка: дополнение не падает (`specs/complete.md`).
          return "";
        }
      },
      stdout: (text) => write(Deno.stdout, text),
      stderr: (text) => write(Deno.stderr, text),
    }),
  );
}
