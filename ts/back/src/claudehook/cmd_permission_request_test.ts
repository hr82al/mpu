/**
 * Справка `mpu claude-hook permission-request` (`claude-hook-permission-request.md`,
 * «Справка» [S23]): однострока, фрагмент настроек — как в эталоне канала,
 * текст целиком — снятый голден `testdata/permission-request-help.txt`.
 */

import { assertEquals } from "@std/assert";
import { claudeHookPermissionRequestCommand as command } from "./cmd_permission_request.ts";

const testdata = (name: string) => new URL(`testdata/${name}`, import.meta.url);

Deno.test("S23: однострока и фрагмент настроек — как в эталоне", async () => {
  assertEquals(
    command.summary,
    "Как ответить на вопрос Claude Code о праве из Telegram?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  assertEquals(
    JSON.parse(fragment),
    JSON.parse(
      await Deno.readTextFile(
        testdata("permission-request/settings-fragment.json"),
      ),
    ),
  );
});

Deno.test("S23: справка — снятый голден", async () => {
  assertEquals(
    command.help,
    await Deno.readTextFile(testdata("permission-request-help.txt")),
  );
});
