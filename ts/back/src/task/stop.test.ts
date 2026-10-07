/**
 * `task stop` и `task resume` (`task-orchestrator.md`, «CLI-контракт»):
 * вид в журнале, ход `остановлен`, порция 0 у проекта без порций.
 */

import { expect, it } from "vitest";
import { taskReadCommand } from "./cmd_read.ts";
import { KINDS } from "./kind.ts";
import { expectRun, setUp, type Stand, withStand } from "./teststand.ts";

async function turnOf(stand: Stand): Promise<string> {
  const run = await stand.agent("task", "status", "end", "json");
  expect(run.code, run.stderr).toBe(0);
  const [row] = JSON.parse(run.stdout) as { turn: string; portion: number }[];
  return `${row.portion} ${row.turn}`;
}

it("stop — ход остановлен, важнее всех; resume — прежний ход", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.agent("task", "post", "project:", "demo", "text:", "x"),
      0,
      "",
      "",
    );
    expectRun(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    expect(await turnOf(stand)).toBe("1 остановлен");
    expectRun(
      await stand.agent("task", "owner", "project:", "demo", "text:", "y?"),
      0,
      "",
      "",
    );
    expect(await turnOf(stand)).toBe("1 остановлен");
    expectRun(
      await stand.human("ask", "task", "resume", "project:", "demo"),
      0,
      "",
      "выполнить mpu task resume project: demo? [y/N] ",
    );
    expect(await turnOf(stand)).toBe("1 ждёт владельца");
  }));

it("stop без text: — тело «стоп»; с причиной — причина", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    expectRun(
      await stand.agent("task", "read", "project:", "demo", "kind:", "stop"),
      0,
      "стоп",
      "",
    );
    expectRun(
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
    expectRun(
      await stand.agent("task", "read", "project:", "demo"),
      0,
      "нет ключа",
      "",
    );
  }));

it("stop в проекте без порций — порция 0, без отказа", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    expect(await turnOf(stand)).toBe("0 остановлен");
    expectRun(
      await stand.agent("task", "post", "project:", "demo", "text:", "x"),
      0,
      "",
      "",
    );
    expect(await turnOf(stand)).toBe("1 остановлен");
  }));

it("чистка при task.history не удаляет действующий stop, отменённый — удаляет", () =>
  withStand(async (stand) => {
    await setUp(stand);
    const say = (kind: string, text: string) =>
      stand.agent("task", kind, "project:", "demo", "text:", text);
    await say("post", "p1");
    expectRun(await stand.agent("task", "stop", "project:", "demo"), 0, "", "");
    await say("report", "r1");
    await say("post", "p2");
    expect(await turnOf(stand)).toBe("2 остановлен");
    await stand.human("ask", "task", "resume", "project:", "demo");
    await say("report", "r2");
    await say("post", "p3");
    const run = await stand.agent(
      "task",
      "history",
      "project:",
      "demo",
      "end",
      "json",
    );
    expect(run.code, run.stderr).toBe(0);
    const kinds = (JSON.parse(run.stdout) as { kind: string }[]).map(
      (row) => row.kind,
    );
    expect(kinds).toStrictEqual(["task"]);
  }, "0"));

it("resume без двери — отказ: посев ask", () =>
  withStand(async (stand) => {
    await setUp(stand);
    const run = await stand.agent("task", "resume", "project:", "demo");
    expect(run.code, run.stderr).toBe(2);
  }));

it("stop в незаведённом проекте — отказ с подсказкой setup", () =>
  withStand(async (stand) => {
    expectRun(
      await stand.agent("task", "stop", "project:", "nope"),
      2,
      "",
      "mpu task stop: нет проекта nope — заведи: mpu ask task setup project: nope\n",
    );
  }));

it("справка read перечисляет виды из списка видов, stop и resume в их числе", () => {
  const listed = `Виды: ${KINDS.map((kind) => kind.word).join(", ")}.`;
  expect(taskReadCommand.help.includes(listed), taskReadCommand.help).toBe(
    true,
  );
  expect(listed.endsWith("rule, stop, resume."), listed).toBe(true);
});
