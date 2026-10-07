/**
 * Точка входа `mpu-complete` (`bun run complete`): дополнение строки
 * `mpu` — от `mpu-back` по петле с основным токеном, а не ответил он за
 * 150 мс — из снимка дерева. Записи нет никакой.
 */

import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { askBack, runComplete } from "./src/mod.ts";

const encoder = new TextEncoder();

/** Сколько ждать `back`: дольше дополнение в оболочке уже заметно. */
const BACK_DEADLINE_MS = 150;

/** Полная запись в дескриптор: `writeSync` может записать часть. */
function write(fd: number, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes.subarray(written));
  }
}

/** Текст файла; не читается — пустая строка. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    // Нет файла или не файл — дополнять из него нечем, и это не ошибка:
    // дополнение не падает (`specs/complete.md`). Нехватка права сборки —
    // дефект, её прятать нельзя: у этого отказа Deno кода ОС нет, у всех
    // ошибок чтения файла — есть.
    if (err instanceof Error && !("code" in err)) throw err;
    return "";
  }
}

if (import.meta.main) {
  const home = process.env.HOME ?? "";
  process.exit(
    await runComplete(process.argv.slice(2), {
      snapshotPath: `${home}/.cache/mpu/tree.json`,
      read: readOrEmpty,
      back: async (line) => {
        const token = (await readOrEmpty(`${home}/.config/mpu/token`)).trim();
        return askBack(line, {
          base: process.env.MPU_BACK_URL ?? "http://127.0.0.1:7338",
          token: token === "" ? undefined : token,
          fetch,
          deadline: () => AbortSignal.timeout(BACK_DEADLINE_MS),
        });
      },
      stdout: (text) => write(1, text),
      stderr: (text) => write(2, text),
    }),
  );
}
