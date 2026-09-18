/**
 * Права задач порции (`platform/supervisor-install.md`): у супервизора —
 * запуск двух программ и `HOME`; у `compile:*` — ровно права задачи
 * запуска (у `back` — плюс `--include` задачи `build`). Версия
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

Deno.test("права супервизора — запуск двух программ и HOME", async () => {
  assertEquals(permissions(await task("supervisor")), [
    "--allow-env=HOME",
    "--allow-run=$HOME/.local/bin/mpu-back,$HOME/.local/bin/mpu-mcp",
  ]);
});

Deno.test("compile:* — права задач запуска, путь — MPU_OUT", async (t) => {
  const pairs = [
    ["compile:back", "back", "back/back.ts"],
    ["compile:mcp", "mcp", "mcp/main.ts"],
    ["compile:cli", "cli", "cli/main.ts"],
    ["compile:supervisor", "supervisor", "supervisor/main.ts"],
  ] as const;
  for (const [compile, run, script] of pairs) {
    await t.step(compile, async () => {
      const words = await task(compile);
      assertEquals(permissions(words), permissions(await task(run)));
      assertEquals(words.slice(-3), ["-o", "$MPU_OUT", script]);
    });
  }
});

Deno.test("compile:back — те же --include, что у build", async () => {
  const includes = (words: readonly string[]) =>
    words.flatMap((word, i) => word === "--include" ? [words[i + 1]] : []);
  assertEquals(
    includes(await task("compile:back")),
    includes(await task("build")),
  );
});

Deno.test("версия супервизора — версия сборки back", async () => {
  const back = (await Deno.readTextFile("back/src/version.ts")).match(
    /export const VERSION = "([^"]+)";/,
  )?.[1];
  assertEquals(VERSION, back);
});
