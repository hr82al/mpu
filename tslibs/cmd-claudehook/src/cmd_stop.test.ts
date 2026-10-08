/**
 * Справка `mpu claude-hook stop` (`claude-hook-stop.md`, «CLI-контракт»,
 * «Установка»): однострока — вопрос, фрагмент настроек — как в эталоне
 * канала.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { claudeHookStopCommand as command } from "./cmd_stop.ts";

it("R2a-12: однострока и фрагмент настроек — как в эталоне", async () => {
  expect(command.summary).toBe(
    "Как сообщить владельцу в Telegram, что сессия Claude Code ждёт ввода?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  expect(JSON.parse(fragment)).toStrictEqual(
    JSON.parse(
      await readFile(
        new URL("testdata/stop/settings-fragment-stop.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});
