/**
 * Настоящий порт docker: `watch` и показывает вывод, и собирает его.
 * Docker не нужен — порт запускает любой бинарь, здесь `/bin/sh`.
 */

import { expect, it } from "vitest";
import { systemDocker } from "./docker.ts";

it("watch: код и оба потока — значением", async () => {
  const outcome = await systemDocker.watch(
    ["/bin/sh", "-c", "echo курс; echo 'backfill: x error' >&2; exit 3"],
    ".",
  );
  expect(outcome).toStrictEqual({
    code: 3,
    stdout: "курс\n",
    stderr: "backfill: x error\n",
  });
});
