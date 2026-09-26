/**
 * Сценарии T1–T24 канала `mpu task` (`task.md`, «Сценарии») на стенде
 * `teststand.ts`.
 */

import { assertEquals, assertMatch } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import type { CacheDb } from "../command/mod.ts";
import { fakeConfigDb, makeFakeIo } from "../testing/mod.ts";
import { age, waitCommand, type Waiting } from "./cmd_read.ts";
import { SETUP_TEXT } from "./texts.ts";
import { asked, expect, setUp, type Stand, withStand } from "./teststand.ts";

/** T4 и T6: постановка положена и прочитана. */
async function postedAndRead(stand: Stand) {
  await setUp(stand);
  expect(
    await stand.agent(
      "task",
      "post",
      "project:",
      "demo",
      "text:",
      "^сделай",
      "x^",
    ),
    0,
    "",
    "",
  );
  expect(
    await stand.agent("task", "read", "project:", "demo"),
    0,
    "сделай x",
    "",
  );
}

/** T8: постановка заменена. */
async function forced(stand: Stand) {
  await postedAndRead(stand);
  expect(
    await stand.agent(
      "task",
      "post",
      "force",
      "project:",
      "demo",
      "text:",
      "y",
    ),
    0,
    "",
    "",
  );
}

/** T10: вопрос исполнителя и вопрос владельцу. */
async function ownerAsked(stand: Stand) {
  await forced(stand);
  await stand.agent(
    "task",
    "question",
    "project:",
    "demo",
    "text:",
    "^почему",
    "y?^",
  );
  await stand.agent(
    "task",
    "owner",
    "project:",
    "demo",
    "text:",
    "^нужен",
    "ли",
    "y?^",
  );
}

async function statusLine(stand: Stand): Promise<string> {
  const run = await stand.agent("task", "status");
  assertEquals(run.code, 0, run.stderr);
  return run.stdout;
}

const OWNER_QUESTION =
  "записать от имени владельца: owner-answer в demo? [y/N] ";

Deno.test("T1: запись без проекта — отказ с подсказкой setup", () =>
  withStand(async (stand) => {
    expect(
      await stand.agent("task", "post", "project:", "demo", "text:", "x"),
      2,
      "",
      "mpu task post: нет проекта demo — заведи: mpu ask task setup project: demo\n",
    );
  }));

Deno.test("T2: setup человеком печатает инструкцию", () => withStand(setUp));

Deno.test("T2: голден setup.txt — текст инструкции побайтово", async () => {
  const golden = await Deno.readTextFile(
    new URL("./testdata/setup.txt", import.meta.url),
  );
  assertEquals(SETUP_TEXT, golden);
});

Deno.test("setup без ключей — инструкция; повтор без note: заметку хранит", () =>
  withStand(async (stand) => {
    expect(
      await stand.human("ask", "task", "setup"),
      0,
      SETUP_TEXT,
      "выполнить mpu task setup? [y/N] ",
    );
    await setUp(stand);
    await stand.human("ask", "task", "setup", "project:", "demo");
    assertMatch(await statusLine(stand), / {2}игрушечный проект\n$/);
  }));

Deno.test("T3: сообщение до первой постановки — отказ", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent(
        "task",
        "report",
        "project:",
        "demo",
        "text:",
        "готово",
      ),
      2,
      "",
      "mpu task report: порций ещё нет — начни с mpu task post project: demo …\n",
    );
  }));

Deno.test("T5: status после постановки — ход исполнителя, непрочитано", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "post", "project:", "demo", "text:", "x");
    assertMatch(
      await statusLine(stand),
      /^demo {2}порция 1 {2}ждёт исполнителя {2}task {2}\d+s {2}непрочитано {2}игрушечный проект\n$/,
    );
  }));

Deno.test("T6–T8: read, отказ второй постановки, замена force", () =>
  withStand(async (stand) => {
    await postedAndRead(stand);
    expect(
      await stand.agent("task", "post", "project:", "demo", "text:", "y"),
      1,
      "",
      "mpu task post: порция 1 не отработана — заменить: mpu task post force project: demo …\n",
    );
    expect(
      await stand.agent(
        "task",
        "post",
        "force",
        "project:",
        "demo",
        "text:",
        "y",
      ),
      0,
      "",
      "",
    );
    expect(await stand.agent("task", "read", "project:", "demo"), 0, "y", "");
    assertMatch(await statusLine(stand), /^demo {2}порция 1 {2}/);
  }));

Deno.test("force без неотработанной постановки — отказ, номер не растёт", () =>
  withStand(async (stand) => {
    await forced(stand);
    await stand.agent("task", "report", "project:", "demo", "text:", "r");
    expect(
      await stand.agent(
        "task",
        "post",
        "force",
        "project:",
        "demo",
        "text:",
        "z",
      ),
      1,
      "",
      "mpu task post: заменять нечего — последнее сообщение в demo не постановка\n",
    );
    assertMatch(
      await statusLine(stand),
      /^demo {2}порция 1 {2}ждёт хоста {2}report {2}/,
    );
  }));

Deno.test("T9, T10: ход выводится из журнала", () =>
  withStand(async (stand) => {
    await forced(stand);
    await stand.agent(
      "task",
      "question",
      "project:",
      "demo",
      "text:",
      "^почему",
      "y?^",
    );
    assertMatch(
      await statusLine(stand),
      /^demo {2}порция 1 {2}ждёт хоста {2}question {2}/,
    );
    await stand.agent(
      "task",
      "owner",
      "project:",
      "demo",
      "text:",
      "^нужен",
      "ли",
      "y?^",
    );
    assertMatch(
      await statusLine(stand),
      /^demo {2}порция 1 {2}ждёт владельца {2}owner {2}/,
    );
  }));

Deno.test("T11: агент не пишет owner-answer даже при allow: на пути", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    expect(
      await stand.human("allow:", "task owner-answer"),
      0,
      '{"path":"task owner-answer","verdict":"allow"}\n',
      "изменить правило: task owner-answer → allow? [y/N] ",
    );
    const before = await stand.agent("task", "history", "end", "json");
    expect(
      await stand.agent(
        "task",
        "owner-answer",
        "project:",
        "demo",
        "text:",
        "да",
      ),
      1,
      "",
      "писать owner-answer может только человек\n",
    );
    assertEquals(await stand.agent("task", "history", "end", "json"), before);
  }));

Deno.test("T12: человек пишет owner-answer — ход возвращается хосту", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    expect(
      await stand.human(
        "task",
        "owner-answer",
        "project:",
        "demo",
        "text:",
        "да",
      ),
      0,
      "",
      OWNER_QUESTION,
    );
    assertMatch(
      await statusLine(stand),
      /^demo {2}порция 1 {2}ждёт хоста {2}owner-answer {2}/,
    );
  }));

Deno.test("человек ответил «нет» — не подтверждено, журнал прежний", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    expect(
      await stand.run(
        ["task", "owner-answer", "project:", "demo", "text:", "да"],
        { answers: ["n"] },
      ),
      1,
      "",
      OWNER_QUESTION +
        "mpu task owner-answer project: demo text: да: не подтверждено\n",
    );
    assertMatch(await statusLine(stand), /ждёт владельца {2}owner {2}/);
  }));

Deno.test("T13, T14: правило, решение и документ decisions", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    await stand.human(
      "task",
      "owner-answer",
      "project:",
      "demo",
      "text:",
      "да",
    );
    expect(
      await stand.human(
        "task",
        "rule",
        "project:",
        "demo",
        "text:",
        "^мерж",
        "—",
        "никогда^",
      ),
      0,
      "",
      "записать от имени владельца: rule в demo? [y/N] ",
    );
    expect(
      await stand.agent("task", "decisions", "project:", "demo"),
      0,
      "## Правила\n\nмерж — никогда\n\n## Порция 1\n\n- owner: нужен ли y?\n- owner-answer: да\n",
      "",
    );
    await stand.agent(
      "task",
      "decision",
      "project:",
      "demo",
      "text:",
      "^y",
      "вместо",
      "x:",
      "правило",
      "3^",
    );
    expect(
      await stand.agent(
        "task",
        "decisions",
        "project:",
        "demo",
        "query:",
        "правило",
      ),
      0,
      "## Правила\n\nмерж — никогда\n\n## Порция 1\n\n- decision: y вместо x: правило 3\n",
      "",
    );
  }));

Deno.test("decisions end json — правила null и порции записью", () =>
  withStand(async (stand) => {
    await setUp(stand);
    const run = await stand.agent(
      "task",
      "decisions",
      "project:",
      "demo",
      "end",
      "json",
    );
    assertEquals(run.code, 0, run.stderr);
    assertEquals(JSON.parse(run.stdout), { rules: null, portions: [] });
  }));

Deno.test("T15: wait не дождался — отказ за срок", () =>
  withStand(async (stand) => {
    await forced(stand);
    using time = new FakeTime();
    const waiting = stand.agent(
      "task",
      "wait",
      "project:",
      "demo",
      "kind:",
      "report",
      "timeout:",
      "1",
    );
    await time.tickAsync(1000);
    expect(
      await waiting,
      1,
      "",
      "mpu task wait: report в demo не пришёл за 1 с\n",
    );
  }));

Deno.test("T16: wait просыпается на отчёте и не отдаёт прочитанное", () =>
  withStand(async (stand) => {
    await forced(stand);
    using time = new FakeTime();
    const waiting = stand.agent(
      "task",
      "wait",
      "project:",
      "demo",
      "kind:",
      "report",
    );
    await time.tickAsync(2000);
    await stand.agent("task", "report", "project:", "demo", "text:", "сделано");
    await time.tickAsync(2000);
    expect(await waiting, 0, "сделано", "");
    const again = stand.agent(
      "task",
      "wait",
      "project:",
      "demo",
      "kind:",
      "report",
      "timeout:",
      "2",
    );
    await time.tickAsync(2000);
    assertEquals((await again).code, 1);
  }));

Deno.test("T17: неизвестный вид — отказ со списком", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent("task", "read", "project:", "demo", "kind:", "ask"),
      2,
      "",
      "mpu task read: неизвестный вид ask — допустимо: task, report, question, answer, decision, owner, owner-answer, rule\n",
    );
  }));

Deno.test("T18, T19: пустое тело и тело дважды", () =>
  withStand(async (stand) => {
    expect(
      await stand.agent(
        "task",
        "post",
        "project:",
        "demo",
        "text:",
        "^",
        "",
        "",
        "^",
      ),
      2,
      "",
      "mpu task post: пустое тело сообщения\n",
    );
    expect(
      await stand.run(
        ["task", "post", "project:", "demo", "text:", "x", "file:", "a.md"],
        { files: { "a.md": "y" } },
      ),
      2,
      "",
      "mpu task post: тело — text: или file:, не оба\n",
    );
  }));

Deno.test("T20: тело из stdin — как его раскрыла строка, без хвостового перевода строки", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.run(
        ["task", "post", "project:", "demo", "text:", "stdin"],
        { stdin: "a\n\n" },
      ),
      0,
      "",
      "",
    );
    expect(
      await stand.agent("task", "read", "project:", "demo"),
      0,
      "a\n",
      "",
    );
  }));

Deno.test("тело из file:", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.run(
      ["task", "post", "project:", "demo", "file:", "p.md"],
      { files: { "p.md": "из файла\n" } },
    );
    expect(
      await stand.agent("task", "read", "project:", "demo"),
      0,
      "из файла\n",
      "",
    );
  }));

/** Пять порций: постановка и отчёт в каждой. */
async function fivePortions(stand: Stand) {
  await setUp(stand);
  for (let portion = 1; portion <= 5; portion++) {
    await stand.agent(
      "task",
      "post",
      "project:",
      "demo",
      "text:",
      `p${portion}`,
    );
    await stand.agent(
      "task",
      "report",
      "project:",
      "demo",
      "text:",
      `r${portion}`,
    );
  }
}

async function portionsLeft(stand: Stand): Promise<number[]> {
  const run = await stand.agent(
    "task",
    "history",
    "project:",
    "demo",
    "end",
    "json",
  );
  assertEquals(run.code, 0, run.stderr);
  const rows = JSON.parse(run.stdout) as { portion: number }[];
  return [...new Set(rows.map((row) => row.portion))].sort();
}

Deno.test("T21: task.history = 3 — журнал хранит порции 3–5", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    assertEquals(await portionsLeft(stand), [3, 4, 5]);
  }, "3"));

Deno.test("T21: task.history = 0 — только текущая порция", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    assertEquals(await portionsLeft(stand), [5]);
  }, "0"));

Deno.test("T21: task.history = -1 — журнал не чистится", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    assertEquals(await portionsLeft(stand), [1, 2, 3, 4, 5]);
  }, "-1"));

Deno.test("чистка сохраняет последнюю редакцию правила", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "post", "project:", "demo", "text:", "p1");
    await stand.human("task", "rule", "project:", "demo", "text:", "старое");
    await stand.human("task", "rule", "project:", "demo", "text:", "новое");
    await stand.agent("task", "report", "project:", "demo", "text:", "r1");
    await stand.agent("task", "post", "project:", "demo", "text:", "p2");
    const run = await stand.agent("task", "decisions", "project:", "demo");
    assertEquals(run.stdout, "## Правила\n\nновое\n");
    assertEquals(await portionsLeft(stand), [1, 2]);
  }, "0"));

Deno.test("T22: history clear без двери — отказ; через дверь — чистка", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    expect(
      await stand.agent("task", "history", "clear", "project:", "demo"),
      2,
      "",
      "mpu task history clear project: demo: требует подтверждения — вызывай mpu ask task history clear project: demo\n",
    );
    const words = ["ask", "task", "history", "clear", "project:", "demo"];
    expect(await stand.human(...words), 0, "", asked(words));
    assertEquals(await portionsLeft(stand), [5]);
  }, "-1"));

Deno.test("T23: агент пишет постановку без человека (посев allow)", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent("task", "post", "project:", "demo", "text:", "z"),
      0,
      "",
      "",
    );
  }));

Deno.test("T24: посев правил канала", () =>
  withStand(async (stand) => {
    const run = await stand.agent("policy");
    assertEquals(run.code, 0, run.stderr);
    const rules = new Map(
      (JSON.parse(run.stdout) as { path: string; verdict: string }[])
        .map((rule) => [rule.path, rule.verdict]),
    );
    for (
      const [path, verdict] of [
        ["task post", "allow"],
        ["task report", "allow"],
        ["task question", "allow"],
        ["task answer", "allow"],
        ["task decision", "allow"],
        ["task owner", "allow"],
        ["task read", "allow"],
        ["task history", "allow"],
        ["task setup", "ask"],
        ["task history clear", "ask"],
      ]
    ) {
      assertEquals(rules.get(path), verdict, path);
    }
    assertEquals(rules.has("task rule"), false);
    assertEquals(rules.has("task owner-answer"), false);
  }));

Deno.test("status end json — записи; пустой проект — хода нет", () =>
  withStand(async (stand) => {
    await setUp(stand);
    assertEquals(
      await statusLine(stand),
      "demo  порция 0  -  -  -  -  игрушечный проект\n",
    );
    const run = await stand.agent("task", "status", "end", "json");
    assertEquals(JSON.parse(run.stdout), [{
      project: "demo",
      portion: 0,
      turn: "-",
      last: null,
      age_s: null,
      unread: false,
      note: "игрушечный проект",
    }]);
  }));

Deno.test("rules печатает эталон хоста побайтово", () =>
  withStand(async (stand) => {
    const golden = await Deno.readTextFile(
      new URL("./testdata/rules.txt", import.meta.url),
    );
    expect(await stand.agent("task", "rules"), 0, golden, "");
  }));

Deno.test("чистка сохраняет открытый owner — ход ждёт владельца", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "post", "project:", "demo", "text:", "p1");
    await stand.agent("task", "owner", "project:", "demo", "text:", "o1");
    await stand.agent("task", "report", "project:", "demo", "text:", "r1");
    await stand.agent("task", "post", "project:", "demo", "text:", "p2");
    assertEquals(await portionsLeft(stand), [1, 2]);
    assertMatch(
      await statusLine(stand),
      /^demo {2}порция 2 {2}ждёт владельца {2}/,
    );
    await stand.human(
      "task",
      "owner-answer",
      "project:",
      "demo",
      "text:",
      "да",
    );
    await stand.agent("task", "report", "project:", "demo", "text:", "r2");
    await stand.agent("task", "post", "project:", "demo", "text:", "p3");
    assertEquals(await portionsLeft(stand), [3]);
  }, "0"));

Deno.test("возраст — крупнейшей целой единицей", () => {
  for (
    const [seconds, text] of [
      [0, "0s"],
      [59, "59s"],
      [60, "1m"],
      [3599, "59m"],
      [3600, "1h"],
      [86399, "23h"],
      [86400, "1d"],
    ] as const
  ) {
    assertEquals(age(seconds), text, String(seconds));
  }
});

Deno.test("чистку не задать ключом в обход режима", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    for (const key of ["mode:", "target:", "selector:"]) {
      const run = await stand.agent(
        "task",
        "history",
        key,
        "clear",
        "project:",
        "demo",
      );
      assertEquals(run.code, 2, `${key} ${run.stderr}`);
    }
    assertEquals(await portionsLeft(stand), [1, 2, 3, 4, 5]);
  }, "-1"));

Deno.test("тело: нет ни text:, ни file:; файл не читается", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(
      await stand.agent("task", "post", "project:", "demo"),
      2,
      "",
      "mpu task post: нет тела — text: или file:\n",
    );
    expect(
      await stand.agent("task", "post", "project:", "demo", "file:", "no.md"),
      2,
      "",
      "mpu task post: не удалось прочитать no.md: нет файла no.md\n",
    );
  }));

Deno.test("setup: note: без project: — отказ ввода", () =>
  withStand(async (stand) => {
    const words = ["ask", "task", "setup", "note:", "x"];
    expect(
      await stand.human(...words),
      2,
      "",
      asked(words) + "mpu task setup: note: без project:\n",
    );
  }));

Deno.test("task.history не целое — умолчание 3", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    assertEquals(await portionsLeft(stand), [3, 4, 5]);
  }, "много"));

Deno.test("агент в строке-программе (^…^) не пишет rule — отказ владельца", () =>
  withStand(async (stand) => {
    await forced(stand);
    expect(
      await stand.agent(
        "task",
        "rule",
        "project:",
        "demo",
        "text:",
        "^мерж",
        "—",
        "никогда^",
      ),
      1,
      "",
      "писать rule может только человек\n",
    );
    const run = await stand.agent("task", "decisions", "project:", "demo");
    assertEquals(run.stdout, "## Правила\n\n(нет)\n");
  }));

Deno.test("rule через дверь — один вопрос, владельца", () =>
  withStand(async (stand) => {
    await forced(stand);
    expect(
      await stand.run(
        ["ask", "task", "rule", "project:", "demo", "text:", "x"],
        { answers: ["y"] },
      ),
      0,
      "",
      "записать от имени владельца: rule в demo? [y/N] ",
    );
  }));

Deno.test("wait не держит соединение с базой между опросами", async () => {
  const db = fakeConfigDb();
  let open = 0;
  const openedDuringSleep: number[] = [];
  const io = makeFakeIo({
    openCacheDb: () => {
      open++;
      const handle: CacheDb = db();
      return { ...handle, [Symbol.dispose]: () => void open-- };
    },
  });
  let now = 0;
  const waiting: Waiting = {
    now: () => now,
    sleep: (ms) => {
      openedDuringSleep.push(open);
      now += ms;
      return Promise.resolve();
    },
  };
  const setup = db();
  setup.bootstrap();
  setup.execute(
    "CREATE TABLE IF NOT EXISTS task_projects (name TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  setup.execute("INSERT INTO task_projects VALUES ('demo', '', 0)");
  const command = waitCommand(waiting);
  let refused = "";
  try {
    await command.invoke(
      ["--project", "demo", "--kind", "report", "--timeout", "5"],
      io,
    );
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  assertEquals(refused, "report в demo не пришёл за 5 с");
  assertEquals(openedDuringSleep, [0, 0, 0]);
  assertEquals(open, 0);
});
