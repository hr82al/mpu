/**
 * Команда `mpu claude-hook notification` в дереве: место, посев, справка
 * с фрагментом настроек (`claude-hook-notification-snapshot.md`, «Права и
 * установка»). Исполнение — ядро (`notify_desk_test.ts`).
 */

import { assertEquals } from "@std/assert";
import { claudeHookNotificationCommand as command } from "./cmd_notification.ts";

Deno.test("команда — подкоманда группы без входов; фрагмент настроек — как в эталоне", async () => {
  assertEquals(command.path, ["claude-hook", "notification"]);
  assertEquals(command.errorName, "claude-hook notification");
  assertEquals(command.inputs, []);
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  assertEquals(
    JSON.parse(fragment),
    JSON.parse(
      await Deno.readTextFile(
        new URL(
          "testdata/snapshot/settings-fragment-notification.json",
          import.meta.url,
        ),
      ),
    ),
  );
});
