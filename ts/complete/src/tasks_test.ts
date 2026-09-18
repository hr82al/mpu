/**
 * Права задач `complete` и `compile:complete` (`specs/complete.md`,
 * `design-mpu.md` п. 6): чтение одного файла снимка и `HOME`. Ни сети,
 * ни записи, ни токенов.
 */

import { assertEquals } from "@std/assert";

async function flags(task: string): Promise<string[]> {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const line = denoJsonc.match(new RegExp(`"${task}": "([^"]*)"`))?.[1] ?? "";
  return line.split(/\s+/).filter((word) => word.startsWith("--allow")).sort();
}

Deno.test("права дополнения — чтение снимка и HOME", async () => {
  const expected = [
    "--allow-env=HOME",
    "--allow-read=$HOME/.cache/mpu/tree.json",
  ];
  assertEquals(await flags("complete"), expected);
  assertEquals(await flags("compile:complete"), expected);
});
