/**
 * `image sync` через MCP (`image-sync.md`, сценарии 28–30): вопрос —
 * формой человеку, Accept — строка исполнена, Decline — не подтверждено,
 * агенту спросить некого.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collected, post } from "../../back/src/backend/testback.ts";
import { call, type Stack, withClient, withStack } from "./testkit.ts";

/** «Три метода» стенда `image-sync.md`. */
const THREE: readonly (readonly string[])[] = [
  "kiten define: cardsIn purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  "kiten define: mine purpose: ^мои^ do kiten ls done",
  "kiten define: shipped purpose: ^готово^ do kiten ls where: column is: Готово done",
].map((line) => ["ask", ...line.split(" ")]);

const SYNC = ["ask", "image", "sync"];

/**
 * Стек с `HOME` во временном каталоге, синхронизированными «тремя
 * методами» и правкой назначения в файле `cardsIn` — состояние сценария 3.
 */
function asInThree(body: (stack: Stack, dir: string) => Promise<void>) {
  return withHome(async (home) => {
    const dir = `${home}/mr/mp/mpu/image`;
    await withStack(
      (stack) =>
        withClient(stack, async (client) => {
          for (const words of [...THREE, SYNC]) {
            const done = await call(stack, client, "mpu", { words });
            expect(done.isError, JSON.stringify(done)).toBe(false);
          }
          const path = `${dir}/kiten/cardsIn:.mpu`;
          const text = await readFile(path, "utf8");
          await writeFile(
            path,
            text.replace("^мои в колонке^", "^мои карточки^"),
          );
          await body(stack, dir);
        }, () => ({ action: "accept", content: {} })),
      { io: { env: (name) => name === "HOME" ? home : undefined } },
    );
  });
}

async function withHome(body: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await mkdir(`${home}/mr/mp/mpu`, { recursive: true });
    await body(home);
  } finally {
    await rm(home, { recursive: true });
  }
}

/** Текст секции stdout/stderr ответа тула (`content` — секции текстом). */
function section(content: unknown, index: number): string {
  return (content as { text: string }[])[index].text;
}

it("28: MCP, Accept — ответ как в 3", () =>
  asInThree(async (stack) =>
    await withClient(stack, async (client) => {
      const result = await call(stack, client, "mpu", { words: SYNC });
      expect(result.isError).toBe(false);
      expect(section(result.content, 0)).toBe(
        "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
      );
    }, () => ({ action: "accept", content: {} }))
  ));

it("29: MCP, Decline — не подтверждено, ничего не изменено", () =>
  asInThree(async (stack, dir) => {
    const path = `${dir}/kiten/cardsIn:.mpu`;
    const before = await readFile(path, "utf8");
    await withClient(stack, async (client) => {
      const result = await call(stack, client, "mpu", { words: SYNC });
      expect(result.isError).toBe(true);
      expect(section(result.content, 1)).toBe(
        "stderr:\nmpu image sync: не подтверждено\n",
      );
    }, () => ({ action: "decline", content: {} }));
    expect(await readFile(path, "utf8")).toStrictEqual(before);
  }));

it("30: агентский вызов — спросить некого", () =>
  asInThree(async (stack) => {
    const reply = await collected(
      stack.back,
      await post(stack.back, "/agent/line", {
        words: SYNC,
        cwd: process.cwd(),
        human: false,
      }, { accept: "application/json", agent: true }),
    );
    expect([reply.exit, reply.stderr]).toStrictEqual([
      1,
      "mpu image sync: нужно подтверждение, а спросить некого\n",
    ]);
  }));
