/**
 * Команда `mpu claude-hook notification` в дереве: место, посев, справка
 * с фрагментом настроек (`claude-hook-notification-snapshot.md`, «Права и
 * установка»). Исполнение — ядро (`notify_desk.test.ts`).
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { claudeHookNotificationCommand as command } from "./cmd_notification.ts";

it("команда — подкоманда группы без входов; фрагмент настроек — как в эталоне", async () => {
  expect(command.path).toStrictEqual(["claude-hook", "notification"]);
  expect(command.errorName).toBe("claude-hook notification");
  expect(command.inputs).toStrictEqual([]);
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  expect(JSON.parse(fragment)).toStrictEqual(
    JSON.parse(
      await readFile(
        new URL(
          "testdata/snapshot/settings-fragment-notification.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
});
