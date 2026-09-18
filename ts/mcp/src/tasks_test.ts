/**
 * Права задачи `mcp` (`platform/mcp-objects.md`, `design-mpu.md` п. 6):
 * сеть петли, чтение двух токенов, запись своего, `HOME` и `MPU_BACK_URL`.
 */

import { assertEquals } from "@std/assert";

Deno.test("права задачи mcp — ровно четыре флага", async () => {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const line = denoJsonc.match(/"mcp": "([^"]*)"/)?.[1] ?? "";
  const flags = line.split(/\s+/).filter((arg) => arg.startsWith("--"));
  assertEquals(flags.sort(), [
    "--allow-env=HOME,MPU_BACK_URL",
    "--allow-net=127.0.0.1",
    "--allow-read=$HOME/.config/mpu/token,$HOME/.config/mpu/mcp-token",
    "--allow-write=$HOME/.config/mpu/mcp-token",
  ]);
  assertEquals(line.endsWith(" mcp/main.ts"), true);
});

Deno.test("срок ответа человека совпадает со сроком номера у back", async () => {
  const constant = async (path: string, name: string) =>
    (await Deno.readTextFile(path)).match(
      new RegExp(`export const ${name} = ([0-9_]+);`),
    )?.[1];
  const back = await constant("back/src/backend/line.ts", "ANSWER_TIMEOUT_MS");
  assertEquals(back !== undefined, true);
  assertEquals(await constant("mcp/src/asker.ts", "ELICIT_TIMEOUT_MS"), back);
});
