/**
 * Сценарии R1–R15 профилей ролей и отметок (`task-roles.md`,
 * «Сценарии») на стенде `teststand.ts`.
 */

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { expect, setUp, type Stand, withStand } from "./teststand.ts";

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
  expect(await stand.human(...R1), 0, "", QUESTION);
}

async function roles(stand: Stand, ...tail: string[]): Promise<string> {
  const run = await stand.agent("task", "roles", "project:", "demo", ...tail);
  assertEquals(run.code, 0, run.stderr);
  return run.stdout;
}

const R2_BLOCK = "exec  -  -\n" +
  "  session: w  window: demo-exec  model: opus  mode: auto\n" +
  "  dir: /tmp/demo/ts\n" +
  "  powers: прод — только чтение\n";

Deno.test("R1, R2: человек пишет профиль, roles печатает умолчания", () =>
  withStand(async (stand) => {
    await profiled(stand);
    assertEquals(await roles(stand), R2_BLOCK);
  }));

Deno.test("R3: агент не меняет профиль — отказ, профиль прежний", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expect(
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
    assertEquals(await roles(stand), R2_BLOCK);
  }));

Deno.test("R3: агент не меняет профиль и при allow: на пути", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.human("allow:", "task role");
    expect(
      await stand.agent(...R1.slice(0, 8), "powers:", "x"),
      1,
      "",
      "менять профиль роли может только человек\n",
    );
    assertEquals(await roles(stand), R2_BLOCK);
  }));

Deno.test("R4, R5: отметки busy и idle с возрастом от их времени", () =>
  withStand(async (stand) => {
    using time = new FakeTime();
    await profiled(stand);
    time.tick(3_600_000);
    const busy = ["task", "busy", "project:", "demo", "role:", "exec"];
    expect(await stand.agent(...busy), 0, "", "");
    assertEquals((await roles(stand)).split("\n")[0], "exec  busy  0s");
    time.tick(5 * 60_000);
    assertEquals((await roles(stand)).split("\n")[0], "exec  busy  5m");
    const idle = ["task", "idle", "project:", "demo", "role:", "exec"];
    expect(await stand.agent(...idle), 0, "", "");
    assertEquals((await roles(stand)).split("\n")[0], "exec  idle  0s");
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

Deno.test("R6, R7: add-dir: списком; профиль заменяется целиком", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expect(await stand.human(...R6), 0, "", QUESTION);
    assertEquals(
      await roles(stand),
      "exec  -  -\n" +
        "  session: w  window: demo-exec  model: sonnet  mode: auto\n" +
        "  dir: /tmp/demo/ts\n" +
        "  add-dir: /tmp/a\n" +
        "  add-dir: /tmp/b\n" +
        "  powers: x\n",
    );
    const r7 = R6.filter((_, i) => i < 10 || i > 11);
    expect(await stand.human(...r7), 0, "", QUESTION);
    assertEquals(
      (await roles(stand)).split("\n")[1],
      "  session: w  window: demo-exec  model: opus  mode: auto",
    );
  }));

Deno.test("R8: каталог роли другого проекта — вопрос, затем отказ", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.human("ask", "task", "setup", "project:", "other");
    expect(
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
    assertEquals(other.stdout, "");
  }));

Deno.test("каталог своей роли — не отказ: профиль заменяется", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expect(await stand.human(...R1), 0, "", QUESTION);
  }));

Deno.test("R9–R11: роль, dir: — вопрос, затем отказ ввода", () =>
  withStand(async (stand) => {
    await setUp(stand);
    const role = ["task", "role", "project:", "demo", "role:"];
    expect(
      await stand.human(...role, "dialog", "dir:", "/tmp", "powers:", "x"),
      2,
      "",
      "изменить профиль роли: demo dialog? [y/N] " +
        "mpu task role: роль dialog — допустимо: host, exec\n",
    );
    expect(
      await stand.human(...role, "exec", "powers:", "x"),
      2,
      "",
      QUESTION + "mpu task role: нет dir: — каталог запуска обязателен\n",
    );
    expect(
      await stand.human(...role, "exec", "dir:", "rel/ts", "powers:", "x"),
      2,
      "",
      QUESTION + "mpu task role: dir: — абсолютный путь, получено rel/ts\n",
    );
    assertEquals(await roles(stand), "");
  }));

Deno.test("нет powers: — отказ ввода", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
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

Deno.test("агент с неверным входом — отказ владельца до проверок", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent("task", "role", "project:", "demo", "role:", "dialog"),
      1,
      "",
      "менять профиль роли может только человек\n",
    );
  }));

Deno.test("отметка: роль не host|exec — отказ ввода", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent("task", "idle", "project:", "demo", "role:", "dialog"),
      2,
      "",
      "mpu task idle: роль dialog — допустимо: host, exec\n",
    );
  }));

Deno.test("R12: отметка без проекта — отказ с подсказкой setup", () =>
  withStand(async (stand) => {
    expect(
      await stand.agent("task", "busy", "project:", "nope", "role:", "exec"),
      2,
      "",
      "mpu task busy: нет проекта nope — заведи: mpu ask task setup project: nope\n",
    );
  }));

Deno.test("R13: человек удаляет профиль — roles пуст", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expect(
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
    assertEquals(await roles(stand), "");
  }));

Deno.test("агент не удаляет профиль — отказ, профиль прежний", () =>
  withStand(async (stand) => {
    await profiled(stand);
    expect(
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
    assertEquals(await roles(stand), R2_BLOCK);
  }));

Deno.test("отметка без профиля хранится, но роль не печатается", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "busy", "project:", "demo", "role:", "host");
    assertEquals(await roles(stand), "");
  }));

Deno.test("R14: roles end json — записи с отметкой", () =>
  withStand(async (stand) => {
    await profiled(stand);
    await stand.agent("task", "busy", "project:", "demo", "role:", "exec");
    assertEquals(
      await roles(stand, "end", "json"),
      '[{"role":"exec","mark":"busy","mark_age_s":0,"session":"w",' +
        '"window":"demo-exec","dir":"/tmp/demo/ts","model":"opus",' +
        '"mode":"auto","add_dir":[],"read":[],' +
        '"powers":"прод — только чтение"}]\n',
    );
  }));

Deno.test("roles end json: отметки не было — null", () =>
  withStand(async (stand) => {
    await profiled(stand);
    const [record] = JSON.parse(await roles(stand, "end", "json"));
    assertEquals([record.mark, record.mark_age_s], [null, null]);
  }));

Deno.test("все ключи профиля: блоки ролей через пустую строку", () =>
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
    assertEquals(
      await roles(stand),
      "host  -  -\n" +
        "  session: s  window: win  model: opus  mode: plan\n" +
        "  dir: /home/u/mr/mp/mpu\n" +
        "  read: /home/u/q.md\n" +
        "  powers: субагенты — нельзя\n" +
        "\n" + R2_BLOCK,
    );
  }));

Deno.test("R15: посев правил ролей", () =>
  withStand(async (stand) => {
    const run = await stand.agent("policy");
    assertEquals(run.code, 0, run.stderr);
    const rules = new Map(
      (JSON.parse(run.stdout) as { path: string; verdict: string }[])
        .map((rule) => [rule.path, rule.verdict]),
    );
    for (const path of ["task roles", "task busy", "task idle"]) {
      assertEquals(rules.get(path), "allow", path);
    }
    assertEquals(rules.has("task role"), false);
    assertEquals(rules.has("task role forget"), false);
  }));
