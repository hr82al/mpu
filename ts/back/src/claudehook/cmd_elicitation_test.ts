/**
 * Справка `mpu claude-hook elicitation` (`claude-hook-elicitation.md`,
 * «CLI-контракт», «Установка»): однострока — вопрос, фрагмент настроек —
 * как в эталоне канала.
 */

import { assertEquals } from "@std/assert";
import { claudeHookElicitationCommand as command } from "./cmd_elicitation.ts";

Deno.test("15: однострока и фрагмент настроек — как в эталоне", async () => {
  assertEquals(
    command.summary,
    "Как ответить на форму MCP-сервера из Telegram?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  assertEquals(
    JSON.parse(fragment),
    JSON.parse(
      await Deno.readTextFile(
        new URL(
          "testdata/elicitation/settings-fragment-elicitation.json",
          import.meta.url,
        ),
      ),
    ),
  );
});
