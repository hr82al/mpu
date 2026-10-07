/**
 * Сценарии R1–R15 профилей ролей и отметок (`task-roles.md`,
 * «Сценарии») на стенде `teststand.ts`.
 */

import { expect, it, vi } from "vitest";
import { fakeTimers } from "../testing/scope.ts";
import { expectRun, setUp, type Stand, withStand } from "./teststand.ts";

const QUESTION = "изменить профиль роли: demo exec? [y/N] ";

const R1 = [
  "task",
  "role",
  "project:",
  "demo",
  "role:",
  "exec",
  "dir:",
  "/tmp/demo/ts",
  "powers:",
  "^прод",
  "—",
  "только",
  "чтение^",
];

/** R1: проект заведён, профиль исполнителя записан человеком. */
async function profiled(stand: Stand) {
  await setUp(stand);
  expectRun(await stand.human(...R1), 0, "", QUESTION);
}

async function roles(stand: Stand, ...tail: string[]): Promise<string> {
  const run = await stand.agent("task", "roles", "project:", "demo", ...tail);
  expect(run.code, run.stderr).toBe(0);
  return run.stdout;
}

const R2_BLOCK = "exec  -  -\n" +
  "  session: w  window: demo-exec  model: opus  mode: auto\n" +
  "  dir: /tmp/demo/ts\n" +
  "  powers: прод — только чтение\n";

it("R1, R2: человек пишет профиль, roles печатает умолчания", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expect(await roles(stand)).toStrictEqual(R2_BLOCK);
  }));

it("R3: агент не меняет профиль — отказ, профиль прежний", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expectRun(
      await stand.agent(
        "task",
        "role",
        "project:",
        "demo",
        "role:",
        "exec",
        "dir:",
        "/tmp/x",
        "powers:",
        "^всё",
        "можно^",
      ),
      1,
      "",
      "менять профиль роли может только человек\n",
    );
    expect(await roles(stand)).toStrictEqual(R2_BLOCK);
  }));

it("R3: агент не меняет профиль и при allow: на пути", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.human("allow:", "task role");
    expectRun(
      await stand.agent(...R1.slice(0, 8), "powers:", "x"),
      1,
      "",
      "менять профиль роли может только человек\n",
    );
    expect(await roles(stand)).toStrictEqual(R2_BLOCK);
  }));

it("R4, R5: отметки busy и idle с возрастом от их времени", () =>
  withStand(async (stand) => {
    fakeTimers();
    await profiled(stand);
    vi.advanceTimersByTime(3_600_000);
    const busy = ["task", "busy", "project:", "demo", "role:", "exec"];
    expectRun(await stand.agent(...busy), 0, "", "");
    expect((await roles(stand)).split("\n")[0]).toBe("exec  busy  0s");
    vi.advanceTimersByTime(5 * 60_000);
    expect((await roles(stand)).split("\n")[0]).toBe("exec  busy  5m");
    const idle = ["task", "idle", "project:", "demo", "role:", "exec"];
    expectRun(await stand.agent(...idle), 0, "", "");
    expect((await roles(stand)).split("\n")[0]).toBe("exec  idle  0s");
  }));

const R6 = [
  ...R1.slice(0, 8),
  "powers:",
  "^x^",
  "model:",
  "sonnet",
  "add-dir:",
  "/tmp/a",
  "add-dir:",
  "/tmp/b",
];

it("R6, R7: add-dir: списком; профиль заменяется целиком", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expectRun(await stand.human(...R6), 0, "", QUESTION);
    expect(await roles(stand)).toStrictEqual(
      "exec  -  -\n" +
        "  session: w  window: demo-exec  model: sonnet  mode: auto\n" +
        "  dir: /tmp/demo/ts\n" +
        "  add-dir: /tmp/a\n" +
        "  add-dir: /tmp/b\n" +
        "  powers: x\n",
    );
    const r7 = R6.filter((_, i) => i < 10 || i > 11);
    expectRun(await stand.human(...r7), 0, "", QUESTION);
    expect((await roles(stand)).split("\n")[1]).toBe(
      "  session: w  window: demo-exec  model: opus  mode: auto",
    );
  }));

it("R8: каталог роли другого проекта — вопрос, затем отказ", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.human("ask", "task", "setup", "project:", "other");
    expectRun(
      await stand.human(
        "task",
        "role",
        "project:",
        "other",
        "role:",
        "exec",
        "dir:",
        "/tmp/demo/ts",
        "powers:",
        "^x^",
      ),
      2,
      "",
      "изменить профиль роли: other exec? [y/N] " +
        "mpu task role: каталог /tmp/demo/ts уже у роли demo exec\n",
    );
    const other = await stand.agent("task", "roles", "project:", "other");
    expect(other.stdout).toBe("");
  }));

it("каталог своей роли — не отказ: профиль заменяется", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expectRun(await stand.human(...R1), 0, "", QUESTION);
  }));

it("R9–R11: роль, dir: — вопрос, затем отказ ввода", () =>
  withStand(async (stand) => {
    await setUp(stand);
    const role = ["task", "role", "project:", "demo", "role:"];
    expectRun(
      await stand.human(...role, "dialog", "dir:", "/tmp", "powers:", "x"),
      2,
      "",
      "изменить профиль роли: demo dialog? [y/N] " +
        "mpu task role: роль dialog — допустимо: host, exec\n",
    );
    expectRun(
      await stand.human(...role, "exec", "powers:", "x"),
      2,
      "",
      QUESTION + "mpu task role: нет dir: — каталог запуска обязателен\n",
    );
    expectRun(
      await stand.human(...role, "exec", "dir:", "rel/ts", "powers:", "x"),
      2,
      "",
      QUESTION + "mpu task role: dir: — абсолютный путь, получено rel/ts\n",
    );
    expect(await roles(stand)).toBe("");
  }));

it("нет powers: — отказ ввода", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.human(
        "task",
        "role",
        "project:",
        "demo",
        "role:",
        "exec",
        "dir:",
        "/tmp",
      ),
      2,
      "",
      QUESTION + "mpu task role: нет powers: — полномочия обязательны\n",
    );
  }));

it("агент с неверным входом — отказ владельца до проверок", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.agent("task", "role", "project:", "demo", "role:", "dialog"),
      1,
      "",
      "менять профиль роли может только человек\n",
    );
  }));

it("отметка: роль не host|exec — отказ ввода", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.agent("task", "idle", "project:", "demo", "role:", "dialog"),
      2,
      "",
      "mpu task idle: роль dialog — допустимо: host, exec\n",
    );
  }));

it("R12: отметка без проекта — отказ с подсказкой setup", () =>
  withStand(async (stand) => {
    expectRun(
      await stand.agent("task", "busy", "project:", "nope", "role:", "exec"),
      2,
      "",
      "mpu task busy: нет проекта nope — заведи: mpu ask task setup project: nope\n",
    );
  }));

it("R13: человек удаляет профиль — roles пуст", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expectRun(
      await stand.human(
        "task",
        "role",
        "forget",
        "project:",
        "demo",
        "role:",
        "exec",
      ),
      0,
      "",
      QUESTION,
    );
    expect(await roles(stand)).toBe("");
  }));

it("агент не удаляет профиль — отказ, профиль прежний", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expectRun(
      await stand.agent(
        "task",
        "role",
        "forget",
        "project:",
        "demo",
        "role:",
        "exec",
      ),
      1,
      "",
      "менять профиль роли может только человек\n",
    );
    expect(await roles(stand)).toStrictEqual(R2_BLOCK);
  }));

it("отметка без профиля хранится, но роль не печатается", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "busy", "project:", "demo", "role:", "host");
    expect(await roles(stand)).toBe("");
  }));

it("R14: roles end json — записи с отметкой", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.agent("task", "busy", "project:", "demo", "role:", "exec");
    expect(await roles(stand, "end", "json")).toStrictEqual(
      '[{"role":"exec","mark":"busy","mark_age_s":0,"session":"w",' +
        '"window":"demo-exec","dir":"/tmp/demo/ts","model":"opus",' +
        '"mode":"auto","add_dir":[],"read":[],' +
        '"powers":"прод — только чтение"}]\n',
    );
  }));

it("roles end json: отметки не было — null", () =>
  withStand(async (stand) => {
    await profiled(stand);
    const [record] = JSON.parse(await roles(stand, "end", "json"));
    expect([record.mark, record.mark_age_s]).toStrictEqual([null, null]);
  }));

it("все ключи профиля: блоки ролей через пустую строку", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.human(
      "task",
      "role",
      "project:",
      "demo",
      "role:",
      "host",
      "dir:",
      "/home/u/mr/mp/mpu",
      "powers:",
      "^субагенты",
      "—",
      "нельзя^",
      "session:",
      "s",
      "window:",
      "win",
      "mode:",
      "plan",
      "read:",
      "/home/u/q.md",
    );
    expect(await roles(stand)).toStrictEqual(
      "host  -  -\n" +
        "  session: s  window: win  model: opus  mode: plan\n" +
        "  dir: /home/u/mr/mp/mpu\n" +
        "  read: /home/u/q.md\n" +
        "  powers: субагенты — нельзя\n" +
        "\n" + R2_BLOCK,
    );
  }));

it("R15: посев правил ролей", () =>
  withStand(async (stand) => {
    const run = await stand.agent("policy");
    expect(run.code, run.stderr).toBe(0);
    const rules = new Map(
      (JSON.parse(run.stdout) as { path: string; verdict: string }[])
        .map((rule) => [rule.path, rule.verdict]),
    );
    for (const path of ["task roles", "task busy", "task idle"]) {
      expect(rules.get(path), path).toBe("allow");
    }
    expect(rules.has("task role")).toBe(false);
    expect(rules.has("task role forget")).toBe(false);
  }));
