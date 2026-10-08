/**
 * Справка `task read` (`task-orchestrator.md`, «CLI-контракт»): виды —
 * из списка видов, `stop` и `resume` в их числе. Сценарии `stop` и
 * `resume` строкой — в `ts/` (`back/src/line/task/stop.test.ts`).
 */

import { expect, it } from "vitest";
import { taskReadCommand } from "./cmd_read.ts";
import { KINDS } from "./kind.ts";

it("справка read перечисляет виды из списка видов, stop и resume в их числе", () => {
  const listed = `Виды: ${KINDS.map((kind) => kind.word).join(", ")}.`;
  expect(taskReadCommand.help.includes(listed), taskReadCommand.help).toBe(
    true,
  );
  expect(listed.endsWith("rule, stop, resume."), listed).toBe(true);
});
