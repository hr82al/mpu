/**
 * `image export` агентским токеном (`image-export.md`, E4): спросить
 * некого, а правило `allow` — строка исполнена без вопроса.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collected, post } from "../../back/src/backend/testback.ts";
import { call, withClient, withStack } from "./testkit.ts";

/** «Три метода» стенда `image-sync.md`. */
const THREE: readonly (readonly string[])[] = [
  "kiten define: cardsIn purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  "kiten define: mine purpose: ^мои^ do kiten ls done",
  "kiten define: shipped purpose: ^готово^ do kiten ls where: column is: Готово done",
].map((line) => ["ask", ...line.split(" ")]);

/** Сценарий 4 `image-sync.md`: `mine` переопределён после синхронизации. */
const AS_IN_FOUR: readonly (readonly string[])[] = [
  ...THREE,
  ["ask", "image", "sync"],
  ["ask", ..."kiten define: mine purpose: ^x^ do kiten ls done".split(" ")],
];

it("E4: агентский вызов — исполнено без вопроса, ответ как в E2", async () => {
  const home = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await mkdir(`${home}/mr/mp/mpu`, { recursive: true });
    await withStack(
      (stack) =>
        withClient(stack, async (client) => {
          for (const words of AS_IN_FOUR) {
            const done = await call(stack, client, "mpu", { words });
            expect(done.isError, JSON.stringify(done)).toBe(false);
          }
          const reply = await collected(
            stack.back,
            await post(stack.back, "/agent/line", {
              words: ["image", "export"],
              cwd: process.cwd(),
              human: false,
            }, { accept: "application/json", agent: true }),
          );
          expect([reply.exit, reply.stdout, reply.stderr]).toStrictEqual([
            0,
            "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
            "",
          ]);
        }, () => ({ action: "accept", content: {} })),
      { io: { env: (name) => name === "HOME" ? home : undefined } },
    );
  } finally {
    await rm(home, { recursive: true });
  }
});
