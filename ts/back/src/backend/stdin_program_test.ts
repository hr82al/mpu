/**
 * Программа из ввода у сервера (`platform/program-input.md`, 170a): одно
 * правило у `POST /line` и у обеих дверей WebSocket — строка без слов с
 * вводом исполняет ввод, без ввода — справка корня.
 */

import { assertEquals } from "@std/assert";
import { Client, type Frame, httpLine, line, withBack } from "./testback.ts";

/** Кадры строки без слов по сокету; ввод — ответом на `stdinRequest`. */
async function piped(
  path: string,
  words: readonly string[],
  stdin: string,
): Promise<Frame[]> {
  let frames: Frame[] = [];
  await withBack(async (back) => {
    const client = new Client(back, path, { stdin });
    await client.opened();
    client.send({
      words,
      cwd: Deno.cwd(),
      human: path === "/line",
      stdinOnRequest: true,
    });
    frames = await client.finished();
  });
  return frames;
}

Deno.test("POST /line без слов: ввод — программа, без ввода — справка", () =>
  withBack(async (back) => {
    const cwd = Deno.cwd();
    assertEquals(
      await httpLine(back, "/line", { words: [], stdin: "2 plus: 2", cwd }),
      [[{ out: "4\n" }, { exit: 0 }]],
    );
    const help = await httpLine(back, "/line", { words: ["help"], cwd });
    assertEquals(await httpLine(back, "/line", { words: [], cwd }), help);
  }));

Deno.test("сокет /line без слов: ввод запрошен сразу и исполнен", async () => {
  assertEquals(await piped("/line", [], "2 plus: 2"), [
    { stdinRequest: true },
    { out: "4\n" },
    { exit: 0 },
  ]);
});

Deno.test("сокет /agent/line: программа с ask-командой — спросить некого", async () => {
  const frames = await piped(
    "/agent/line",
    ["ask"],
    "kiten comment id: 11 text: a",
  );
  assertEquals(frames.at(-1), { exit: 1 });
  assertEquals(
    frames.filter((frame) => "err" in frame),
    [{
      err: "mpu kiten comment id: 11 text: a: нужно подтверждение, а " +
        "спросить некого\n",
    }],
  );
});

Deno.test("сокет /line со словами: ввода не просит", () =>
  withBack(async (back) => {
    const frames = await line(back, "/line", ["version"]);
    assertEquals(frames.some((frame) => "stdinRequest" in frame), false);
  }));
