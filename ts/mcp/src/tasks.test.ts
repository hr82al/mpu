/**
 * Права задачи `mcp` (`platform/mcp-objects.md`, `design-mpu.md` п. 6):
 * сеть петли, чтение двух токенов, запись своего, `HOME` и `MPU_BACK_URL`.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("права задачи mcp — ровно четыре флага", async () => {
  const denoJsonc = await readFile("deno.jsonc", "utf8");
  const line = denoJsonc.match(/"mcp": "([^"]*)"/)?.[1] ?? "";
  const flags = line.split(/\s+/).filter((arg) => arg.startsWith("--"));
  expect(flags.sort()).toStrictEqual([
    "--allow-env=HOME,MPU_BACK_URL",
    "--allow-net=127.0.0.1",
    "--allow-read=$HOME/.config/mpu/token,$HOME/.config/mpu/mcp-token",
    "--allow-write=$HOME/.config/mpu/mcp-token",
  ]);
  expect(line.endsWith(" mcp/main.ts")).toBe(true);
});

it("срок ответа человека совпадает со сроком номера у back", async () => {
  const constant = async (path: string, name: string) =>
    (await readFile(path, "utf8")).match(
      new RegExp(`export const ${name} = ([0-9_]+);`),
    )?.[1];
  const back = await constant("back/src/backend/line.ts", "ANSWER_TIMEOUT_MS");
  expect(back !== undefined).toBe(true);
  expect(await constant("mcp/src/asker.ts", "ELICIT_TIMEOUT_MS")).toStrictEqual(
    back,
  );
});
