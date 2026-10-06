/**
 * Справка `mpu claude-hook stop` (`claude-hook-stop.md`, «CLI-контракт»,
 * «Установка»): однострока — вопрос, фрагмент настроек — как в эталоне
 * канала.
 */

import { assertEquals } from "@std/assert";
import { claudeHookStopCommand as command } from "./cmd_stop.ts";

Deno.test("R2a-12: однострока и фрагмент настроек — как в эталоне", async () => {
  assertEquals(
    command.summary,
    "Как сообщить владельцу в Telegram, что сессия Claude Code ждёт ввода?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  assertEquals(
    JSON.parse(fragment),
    JSON.parse(
      await Deno.readTextFile(
        new URL("testdata/stop/settings-fragment-stop.json", import.meta.url),
      ),
    ),
  );
});
