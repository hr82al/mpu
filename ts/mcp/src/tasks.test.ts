/**
 * Срок ответа человека у переводчика MCP — тот же, что срок номера у
 * `back` (`platform/mcp-objects.md`).
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

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
