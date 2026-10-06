/**
 * Строка хука `PreToolUse` тулом `mpu` (`claude-hook-pre-tool-use.md`,
 * S22): stdin у MCP нет — ответ «вход не разобран», код 0; своего тула у
 * команды нет (список тулов — `mcp_test.ts`).
 */

import { assertEquals } from "@std/assert";
import { PRE_TOOL_USE } from "../../back/src/frames/mod.ts";
import { call, withClient, withStack } from "./testkit.ts";

Deno.test("S22: тул mpu со словами хука — вход не разобран, код 0", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const hook = await call(stack, client, "mpu", {
        words: PRE_TOOL_USE.words,
      });
      assertEquals(hook.isError, false);
      assertEquals(hook.content, [
        { type: "text", text: "" },
        {
          type: "text",
          text: `stderr:\n${
            PRE_TOOL_USE.undecided("вход не разобран: stdin — не JSON-объект")
          }`,
        },
      ]);
    })
  ));
