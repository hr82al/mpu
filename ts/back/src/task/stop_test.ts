/**
 * `task stop` и `task resume` (`task-orchestrator.md`, «CLI-контракт»):
 * вид в журнале, ход `остановлен`, порция 0 у проекта без порций.
 */

import { assertEquals } from "@std/assert";
import { taskReadCommand } from "./cmd_read.ts";
import { KINDS } from "./kind.ts";
import { expect, setUp, type Stand, withStand } from "./teststand.ts";

async function turnOf(stand: Stand): Promise<string> {
  const run = await stand.agent("task", "status", "end", "json");
  assertEquals(run.code, 0, run.stderr);
  const [row] = JSON.parse(run.stdout) as { turn: string; portion: number }[];
  return `${row.portion} ${row.turn}`;
}

Deno.test("stop — ход остановлен, важнее всех; resume — прежний ход", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent("task", "post", "project:", "demo", "text:", "x"),
      0,
      "",
      "",
    );
    expect(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    assertEquals(await turnOf(stand), "1 остановлен");
    expect(
      await stand.agent("task", "owner", "project:", "demo", "text:", "y?"),
      0,
      "",
      "",
    );
    assertEquals(await turnOf(stand), "1 остановлен");
    expect(
      await stand.human("ask", "task", "resume", "project:", "demo"),
      0,
      "",
      "выполнить mpu task resume project: demo? [y/N] ",
    );
    assertEquals(await turnOf(stand), "1 ждёт владельца");
  }));

Deno.test("stop без text: — тело «стоп»; с причиной — причина", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    expect(
      await stand.agent("task", "read", "project:", "demo", "kind:", "stop"),
      0,
      "стоп",
      "",
    );
    expect(
      await stand.agent(
        "task",
        "stop",
        "project:",
        "demo",
        "text:",
        "^нет ключа^",
      ),
      0,
      "",
      "",
    );
    expect(
      await stand.agent("task", "read", "project:", "demo"),
      0,
      "нет ключа",
      "",
    );
  }));

Deno.test("stop в проекте без порций — порция 0, без отказа", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    assertEquals(await turnOf(stand), "0 остановлен");
    expect(
      await stand.agent("task", "post", "project:", "demo", "text:", "x"),
      0,
      "",
      "",
    );
    assertEquals(await turnOf(stand), "1 остановлен");
  }));

Deno.test("resume без двери — отказ: посев ask", () =>
  withStand(async (stand) => {
    await setUp(stand);
    const run = await stand.agent("task", "resume", "project:", "demo");
    assertEquals(run.code, 2, run.stderr);
  }));

Deno.test("stop в незаведённом проекте — отказ с подсказкой setup", () =>
  withStand(async (stand) => {
    expect(
      await stand.agent("task", "stop", "project:", "nope"),
      2,
      "",
      "mpu task stop: нет проекта nope — заведи: mpu ask task setup project: nope\n",
    );
  }));

Deno.test("справка read перечисляет виды из списка видов, stop и resume в их числе", () => {
  const listed = `Виды: ${KINDS.map((kind) => kind.word).join(", ")}.`;
  assertEquals(
    taskReadCommand.help.includes(listed),
    true,
    taskReadCommand.help,
  );
  assertEquals(listed.endsWith("rule, stop, resume."), true, listed);
});
