/**
 * Точка входа `mpu-complete` (`deno task complete`): дополнение строки
 * `mpu` — от `mpu-back` по петле с основным токеном, а не ответил он за
 * 150 мс — из снимка дерева. Записи нет никакой.
 */

import { askBack, runComplete } from "./src/mod.ts";

const encoder = new TextEncoder();

/** Сколько ждать `back`: дольше дополнение в оболочке уже заметно. */
const BACK_DEADLINE_MS = 150;

function write(file: { writeSync(p: Uint8Array): number }, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += file.writeSync(bytes.subarray(written));
  }
}

/** Текст файла; не читается — пустая строка. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    // Нет файла или не файл — дополнять из него нечем, и это не ошибка:
    // дополнение не падает (`specs/complete.md`). Нехватка права — дефект
    // сборки, её прятать нельзя.
    if (err instanceof Deno.errors.NotCapable) throw err;
    return "";
  }
}

if (import.meta.main) {
  const home = Deno.env.get("HOME") ?? "";
  Deno.exit(
    await runComplete(Deno.args, {
      snapshotPath: `${home}/.cache/mpu/tree.json`,
      read: readOrEmpty,
      back: async (line) => {
        const token = (await readOrEmpty(`${home}/.config/mpu/token`)).trim();
        return askBack(line, {
          base: Deno.env.get("MPU_BACK_URL") ?? "http://127.0.0.1:7338",
          token: token === "" ? undefined : token,
          fetch,
          deadline: () => AbortSignal.timeout(BACK_DEADLINE_MS),
        });
      },
      stdout: (text) => write(Deno.stdout, text),
      stderr: (text) => write(Deno.stderr, text),
    }),
  );
}
