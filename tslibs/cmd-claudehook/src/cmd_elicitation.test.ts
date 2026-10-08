/**
 * Справка `mpu claude-hook elicitation` (`claude-hook-elicitation.md`,
 * «CLI-контракт», «Установка»): однострока — вопрос, фрагмент настроек —
 * как в эталоне канала.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { claudeHookElicitationCommand as command } from "./cmd_elicitation.ts";

it("15: однострока и фрагмент настроек — как в эталоне", async () => {
  expect(command.summary).toBe(
    "Как ответить на форму MCP-сервера из Telegram?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  expect(JSON.parse(fragment)).toStrictEqual(
    JSON.parse(
      await readFile(
        new URL(
          "testdata/elicitation/settings-fragment-elicitation.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
});
