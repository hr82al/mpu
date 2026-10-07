/**
 * Справка `mpu claude-hook permission-request` (`claude-hook-permission-request.md`,
 * «Справка» [S23]): однострока, фрагмент настроек — как в эталоне канала,
 * текст целиком — снятый голден `testdata/permission-request-help.txt`.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { claudeHookPermissionRequestCommand as command } from "./cmd_permission_request.ts";

const testdata = (name: string) => new URL(`testdata/${name}`, import.meta.url);

it("S23: однострока и фрагмент настроек — как в эталоне", async () => {
  expect(command.summary).toBe(
    "Как ответить на вопрос Claude Code о праве из Telegram?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  expect(JSON.parse(fragment)).toStrictEqual(JSON.parse(
    await readFile(
      testdata("permission-request/settings-fragment.json"),
      "utf8",
    ),
  ));
});

it("S23: справка — снятый голден", async () => {
  expect(command.help).toStrictEqual(
    await readFile(testdata("permission-request-help.txt"), "utf8"),
  );
});
