/**
 * Версии Vite и vitest в задачах `web`, `compile:web`, `web:test` — те
 * же, что в карте импорта: `npm:` в командной строке её не читает.
 */

import { assertEquals } from "@std/assert";

Deno.test("версии Vite и vitest в задачах совпадают с imports", async () => {
  const text = await Deno.readTextFile("deno.jsonc");
  const pinned = (name: string) =>
    text.match(new RegExp(`"${name}": "npm:${name}@([^"]+)"`))?.[1];
  const inTasks = (name: string) =>
    [...text.matchAll(new RegExp(`npm:${name}@([0-9.]+)`, "g"))].map((m) =>
      m[1]
    );
  for (const name of ["vite", "vitest"]) {
    const version = pinned(name);
    assertEquals(version !== undefined, true, name);
    for (const used of inTasks(name)) assertEquals(used, version, name);
  }
});
