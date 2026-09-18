/**
 * Компонентные тесты фронта (vitest, jsdom) — часть общего прогона
 * `deno task test`: сами они идут под vitest, Deno.test их запускает.
 */

import { assertEquals } from "@std/assert";

Deno.test("компонентные тесты фронта (vitest)", async () => {
  const output = await new Deno.Command("deno", {
    args: ["task", "web:test"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout) +
    new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, text);
});
