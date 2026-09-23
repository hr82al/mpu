/**
 * Права задач порции (`platform/supervisor-install.md`): у супервизора —
 * запуск двух программ, `HOME` и права сторожа памяти
 * (`platform/line-executor.md`); у `compile:*` — ровно права задачи
 * запуска (у `back` и `worker` — плюс `--include` воркера и двух
 * `.wasm`); права `worker` — права `back`. Версия
 * супервизора — та же, что у `back/src/version.ts`.
 */

import { assertEquals } from "@std/assert";
import { VERSION } from "./mod.ts";

async function task(name: string): Promise<string[]> {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const line = denoJsonc.match(new RegExp(`"${name}": "([^"]*)"`))?.[1];
  assertEquals(line !== undefined, true, `нет задачи ${name}`);
  return (line ?? "").split(/\s+/);
}

const permissions = (words: readonly string[]) =>
  words.filter((word) =>
    word.startsWith("--allow") || word.startsWith("--deny")
  )
    .sort();

Deno.test("права супервизора — дочерние, сторож памяти и его отметки", async () => {
  assertEquals(permissions(await task("supervisor")), [
    "--allow-env=HOME,XDG_RUNTIME_DIR",
    "--allow-run=$HOME/.local/bin/mpu-back,$HOME/.local/bin/mpu-mcp," +
    "/usr/bin/ps,/usr/bin/cat,/usr/bin/kill",
    "--allow-write=$XDG_RUNTIME_DIR/mpu/killed",
  ]);
});

Deno.test("compile:* — права задач запуска, путь — MPU_OUT", async (t) => {
  const pairs = [
    ["compile:back", "back", "back/back.ts"],
    ["compile:worker", "worker", "back/worker.ts"],
    ["compile:mcp", "mcp", "mcp/main.ts"],
    ["compile:cli", "cli", "cli/main.ts"],
    ["compile:supervisor", "supervisor", "supervisor/main.ts"],
    ["compile:complete", "complete", "complete/main.ts"],
  ] as const;
  for (const [compile, run, script] of pairs) {
    await t.step(compile, async () => {
      const words = await task(compile);
      assertEquals(permissions(words), permissions(await task(run)));
      assertEquals(words.slice(-3), ["-o", "$MPU_OUT", script]);
    });
  }
});

Deno.test("права исполнителя строк — права ядра", async () => {
  // Та же программа команд (`platform/line-executor.md`): исполнителю
  // нужно всё, что нужно команде, и не больше, чем ядру.
  assertEquals(
    permissions(await task("worker")),
    permissions(await task("back")),
  );
});

Deno.test("compile:back несёт воркер разбора и оба .wasm Telegram", async () => {
  // Без них собранный `mpu-back` падает на `code` и `telegram`
  // (`platform/supervisor-install.md`). Сравнивать теперь не с чем:
  // задача монолита ушла вместе с его точкой входа.
  const includes = (words: readonly string[]) =>
    words.flatMap((word, i) => word === "--include" ? [words[i + 1]] : []);
  for (const name of ["compile:back", "compile:worker"]) {
    assertEquals(includes(await task(name)), [
      "back/src/code/repo_worker.ts",
      "back/src/telegram/mtcute.wasm",
      "back/src/telegram/mtcute-simd.wasm",
    ], name);
  }
});

Deno.test("версия супервизора — версия сборки back", async () => {
  const back = (await Deno.readTextFile("back/src/version.ts")).match(
    /export const VERSION = "([^"]+)";/,
  )?.[1];
  assertEquals(VERSION, back);
});
