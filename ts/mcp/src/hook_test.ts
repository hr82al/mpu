/**
 * Строки-хуки тулом `mpu` (`claude-hook-pre-tool-use.md`, S22;
 * `claude-hook-permission-request.md`, S24): stdin у MCP нет — ответ
 * «вход не разобран», код 0; своего тула у команд нет (список тулов —
 * `mcp_test.ts`).
 */

import { assertEquals } from "@std/assert";
import { PERMISSION_REQUEST, PRE_TOOL_USE } from "../../back/src/frames/mod.ts";
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

Deno.test("S24: тул mpu со словами permission-request — вход не разобран, код 0", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const hook = await call(stack, client, "mpu", {
        words: PERMISSION_REQUEST.words,
      });
      assertEquals(hook.isError, false);
      assertEquals(hook.content, [
        { type: "text", text: "" },
        {
          type: "text",
          text: `stderr:\n${
            PERMISSION_REQUEST.undecided(
              "вход не разобран: stdin — не JSON-объект",
            )
          }`,
        },
      ]);
    })
  ));
