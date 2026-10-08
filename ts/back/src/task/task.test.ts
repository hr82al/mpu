/**
 * Сценарии T1–T24 канала `mpu task` (`task.md`, «Сценарии») на стенде
 * `teststand.ts`.
 */

import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fakeTimers } from "../vitest/scope.ts";
import type { CacheDb } from "@mpu/command";
import { fakeConfigDb, makeFakeIo } from "@mpu/command/testing";
import { age, waitCommand, type Waiting } from "./cmd_read.ts";
import { SETUP_TEXT } from "./texts.ts";
import { asked, expectRun, setUp, type Stand, withStand } from "./teststand.ts";

/** T4 и T6: постановка положена и прочитана. */
async function postedAndRead(stand: Stand) {
  await setUp(stand);
  expectRun(
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
  expectRun(
    await stand.agent("task", "read", "project:", "demo"),
    0,
    "сделай x",
    "",
  );
}

/** T8: постановка заменена. */
async function forced(stand: Stand) {
  await postedAndRead(stand);
  expectRun(
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
  expect(run.code, run.stderr).toBe(0);
  return run.stdout;
}

const OWNER_QUESTION =
  "записать от имени владельца: owner-answer в demo? [y/N] ";

it("T1: запись без проекта — отказ с подсказкой setup", () =>
  withStand(async (stand) => {
    expectRun(
      await stand.agent("task", "post", "project:", "demo", "text:", "x"),
      2,
      "",
      "mpu task post: нет проекта demo — заведи: mpu ask task setup project: demo\n",
    );
  }));

it("T2: setup человеком печатает инструкцию", () => withStand(setUp));

it("T2: голден setup.txt — текст инструкции побайтово", async () => {
  const golden = await readFile(
    new URL("./testdata/setup.txt", import.meta.url),
    "utf8",
  );
  expect(SETUP_TEXT).toStrictEqual(golden);
});

it("setup без ключей — инструкция; повтор без note: заметку хранит", () =>
  withStand(async (stand) => {
    expectRun(
      await stand.human("ask", "task", "setup"),
      0,
      SETUP_TEXT,
      "выполнить mpu task setup? [y/N] ",
    );
    await setUp(stand);
    await stand.human("ask", "task", "setup", "project:", "demo");
    expect(await statusLine(stand)).toMatch(/ {2}игрушечный проект\n$/);
  }));

it("T3: сообщение до первой постановки — отказ", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
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

it("T5: status после постановки — ход исполнителя, непрочитано", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "post", "project:", "demo", "text:", "x");
    expect(await statusLine(stand)).toMatch(
      /^demo {2}порция 1 {2}ждёт исполнителя {2}task {2}\d+s {2}непрочитано {2}игрушечный проект\n$/,
    );
  }));

it("T6–T8: read, отказ второй постановки, замена force", () =>
  withStand(async (stand) => {
    await postedAndRead(stand);
    expectRun(
      await stand.agent("task", "post", "project:", "demo", "text:", "y"),
      1,
      "",
      "mpu task post: порция 1 не отработана — заменить: mpu task post force project: demo …\n",
    );
    expectRun(
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
    expectRun(
      await stand.agent("task", "read", "project:", "demo"),
      0,
      "y",
      "",
    );
    expect(await statusLine(stand)).toMatch(/^demo {2}порция 1 {2}/);
  }));

it("force без неотработанной постановки — отказ, номер не растёт", () =>
  withStand(async (stand) => {
    await forced(stand);
    await stand.agent("task", "report", "project:", "demo", "text:", "r");
    expectRun(
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
    expect(await statusLine(stand)).toMatch(
      /^demo {2}порция 1 {2}ждёт хоста {2}report {2}/,
    );
  }));

it("T9, T10: ход выводится из журнала", () =>
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
    expect(await statusLine(stand)).toMatch(
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
    expect(await statusLine(stand)).toMatch(
      /^demo {2}порция 1 {2}ждёт владельца {2}owner {2}/,
    );
  }));

it("T11: агент не пишет owner-answer даже при allow: на пути", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    expectRun(
      await stand.human("allow:", "task owner-answer"),
      0,
      '{"path":"task owner-answer","verdict":"allow"}\n',
      "изменить правило: task owner-answer → allow? [y/N] ",
    );
    const before = await stand.agent("task", "history", "end", "json");
    expectRun(
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
    expect(await stand.agent("task", "history", "end", "json")).toStrictEqual(
      before,
    );
  }));

it("T12: человек пишет owner-answer — ход возвращается хосту", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    expectRun(
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
    expect(await statusLine(stand)).toMatch(
      /^demo {2}порция 1 {2}ждёт хоста {2}owner-answer {2}/,
    );
  }));

it("человек ответил «нет» — не подтверждено, журнал прежний", () =>
  withStand(async (stand) => {
    await ownerAsked(stand);
    expectRun(
      await stand.run(
        ["task", "owner-answer", "project:", "demo", "text:", "да"],
        { answers: ["n"] },
      ),
      1,
      "",
      OWNER_QUESTION +
        "mpu task owner-answer project: demo text: да: не подтверждено\n",
    );
    expect(await statusLine(stand)).toMatch(/ждёт владельца {2}owner {2}/);
  }));

it("T13, T14: правило, решение и документ decisions", () =>
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
    expectRun(
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
    expectRun(
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
    expectRun(
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

it("decisions end json — правила null и порции записью", () =>
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
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toStrictEqual({ rules: null, portions: [] });
  }));

it("T15: wait не дождался — отказ за срок", () =>
  withStand(async (stand) => {
    await forced(stand);
    fakeTimers();
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
    await vi.advanceTimersByTimeAsync(1000);
    expectRun(
      await waiting,
      1,
      "",
      "mpu task wait: report в demo не пришёл за 1 с\n",
    );
  }));

it("T16: wait просыпается на отчёте и не отдаёт прочитанное", () =>
  withStand(async (stand) => {
    await forced(stand);
    fakeTimers();
    const waiting = stand.agent(
      "task",
      "wait",
      "project:",
      "demo",
      "kind:",
      "report",
    );
    await vi.advanceTimersByTimeAsync(2000);
    await stand.agent("task", "report", "project:", "demo", "text:", "сделано");
    await vi.advanceTimersByTimeAsync(2000);
    expectRun(await waiting, 0, "сделано", "");
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
    await vi.advanceTimersByTimeAsync(2000);
    expect((await again).code).toBe(1);
  }));

it("T17: неизвестный вид — отказ со списком", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.agent("task", "read", "project:", "demo", "kind:", "ask"),
      2,
      "",
      "mpu task read: неизвестный вид ask — допустимо: task, report, question, answer, decision, owner, owner-answer, rule, stop, resume\n",
    );
  }));

it("T18, T19: пустое тело и тело дважды", () =>
  withStand(async (stand) => {
    expectRun(
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
    expectRun(
      await stand.run(
        ["task", "post", "project:", "demo", "text:", "x", "file:", "a.md"],
        { files: { "a.md": "y" } },
      ),
      2,
      "",
      "mpu task post: тело — text: или file:, не оба\n",
    );
  }));

it("T20: тело из stdin — как его раскрыла строка, без хвостового перевода строки", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.run(["task", "post", "project:", "demo", "text:", "stdin"], {
        stdin: "a\n\n",
      }),
      0,
      "",
      "",
    );
    expectRun(
      await stand.agent("task", "read", "project:", "demo"),
      0,
      "a\n",
      "",
    );
  }));

it("тело из file:", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.run(["task", "post", "project:", "demo", "file:", "p.md"], {
      files: { "p.md": "из файла\n" },
    });
    expectRun(
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
  expect(run.code, run.stderr).toBe(0);
  const rows = JSON.parse(run.stdout) as { portion: number }[];
  return [...new Set(rows.map((row) => row.portion))].sort();
}

it("T21: task.history = 3 — журнал хранит порции 3–5", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    expect(await portionsLeft(stand)).toStrictEqual([3, 4, 5]);
  }, "3"));

it("T21: task.history = 0 — только текущая порция", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    expect(await portionsLeft(stand)).toStrictEqual([5]);
  }, "0"));

it("T21: task.history = -1 — журнал не чистится", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    expect(await portionsLeft(stand)).toStrictEqual([1, 2, 3, 4, 5]);
  }, "-1"));

it("чистка сохраняет последнюю редакцию правила", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "post", "project:", "demo", "text:", "p1");
    await stand.human("task", "rule", "project:", "demo", "text:", "старое");
    await stand.human("task", "rule", "project:", "demo", "text:", "новое");
    await stand.agent("task", "report", "project:", "demo", "text:", "r1");
    await stand.agent("task", "post", "project:", "demo", "text:", "p2");
    const run = await stand.agent("task", "decisions", "project:", "demo");
    expect(run.stdout).toBe("## Правила\n\nновое\n");
    expect(await portionsLeft(stand)).toStrictEqual([1, 2]);
  }, "0"));

it("T22: history clear без двери — отказ; через дверь — чистка", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    expectRun(
      await stand.agent("task", "history", "clear", "project:", "demo"),
      2,
      "",
      "mpu task history clear project: demo: требует подтверждения — вызывай mpu ask task history clear project: demo\n",
    );
    const words = ["ask", "task", "history", "clear", "project:", "demo"];
    expectRun(await stand.human(...words), 0, "", asked(words));
    expect(await portionsLeft(stand)).toStrictEqual([5]);
  }, "-1"));

it("T23: агент пишет постановку без человека (посев allow)", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.agent("task", "post", "project:", "demo", "text:", "z"),
      0,
      "",
      "",
    );
  }));

it("T24: посев правил канала", () =>
  withStand(async (stand) => {
    const run = await stand.agent("policy");
    expect(run.code, run.stderr).toBe(0);
    const rules = new Map(
      (JSON.parse(run.stdout) as { path: string; verdict: string }[]).map(
        (rule) => [rule.path, rule.verdict],
      ),
    );
    for (const [path, verdict] of [
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
      ["task stop", "allow"],
      ["task resume", "ask"],
    ]) {
      expect(rules.get(path), path).toStrictEqual(verdict);
    }
    expect(rules.has("task rule")).toBe(false);
    expect(rules.has("task owner-answer")).toBe(false);
  }));

it("status end json — записи; пустой проект — хода нет", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expect(await statusLine(stand)).toBe(
      "demo  порция 0  -  -  -  -  игрушечный проект\n",
    );
    const run = await stand.agent("task", "status", "end", "json");
    expect(JSON.parse(run.stdout)).toStrictEqual([
      {
        project: "demo",
        portion: 0,
        turn: "-",
        last: null,
        age_s: null,
        unread: false,
        note: "игрушечный проект",
      },
    ]);
  }));

it("rules печатает эталон хоста побайтово", () =>
  withStand(async (stand) => {
    const golden = await readFile(
      new URL("./testdata/rules.txt", import.meta.url),
      "utf8",
    );
    expectRun(await stand.agent("task", "rules"), 0, golden, "");
  }));

it("чистка сохраняет открытый owner — ход ждёт владельца", () =>
  withStand(async (stand) => {
    await setUp(stand);
    await stand.agent("task", "post", "project:", "demo", "text:", "p1");
    await stand.agent("task", "owner", "project:", "demo", "text:", "o1");
    await stand.agent("task", "report", "project:", "demo", "text:", "r1");
    await stand.agent("task", "post", "project:", "demo", "text:", "p2");
    expect(await portionsLeft(stand)).toStrictEqual([1, 2]);
    expect(await statusLine(stand)).toMatch(
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
    expect(await portionsLeft(stand)).toStrictEqual([3]);
  }, "0"));

it("возраст — крупнейшей целой единицей", () => {
  for (const [seconds, text] of [
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86399, "23h"],
    [86400, "1d"],
  ] as const) {
    expect(age(seconds), String(seconds)).toStrictEqual(text);
  }
});

it("чистку не задать ключом в обход режима", () =>
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
      expect(run.code, `${key} ${run.stderr}`).toBe(2);
    }
    expect(await portionsLeft(stand)).toStrictEqual([1, 2, 3, 4, 5]);
  }, "-1"));

it("тело: нет ни text:, ни file:; файл не читается", () =>
  withStand(async (stand) => {
    await setUp(stand);
    expectRun(
      await stand.agent("task", "post", "project:", "demo"),
      2,
      "",
      "mpu task post: нет тела — text: или file:\n",
    );
    expectRun(
      await stand.agent("task", "post", "project:", "demo", "file:", "no.md"),
      2,
      "",
      "mpu task post: не удалось прочитать no.md: нет файла no.md\n",
    );
  }));

it("setup: note: без project: — отказ ввода", () =>
  withStand(async (stand) => {
    const words = ["ask", "task", "setup", "note:", "x"];
    expectRun(
      await stand.human(...words),
      2,
      "",
      asked(words) + "mpu task setup: note: без project:\n",
    );
  }));

it("task.history не целое — умолчание 3", () =>
  withStand(async (stand) => {
    await fivePortions(stand);
    expect(await portionsLeft(stand)).toStrictEqual([3, 4, 5]);
  }, "много"));

it("агент в строке-программе (^…^) не пишет rule — отказ владельца", () =>
  withStand(async (stand) => {
    await forced(stand);
    expectRun(
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
    expect(run.stdout).toBe("## Правила\n\n(нет)\n");
  }));

it("rule через дверь — один вопрос, владельца", () =>
  withStand(async (stand) => {
    await forced(stand);
    expectRun(
      await stand.run(
        ["ask", "task", "rule", "project:", "demo", "text:", "x"],
        { answers: ["y"] },
      ),
      0,
      "",
      "записать от имени владельца: rule в demo? [y/N] ",
    );
  }));

it("wait не держит соединение с базой между опросами", async () => {
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
  expect(refused).toBe("report в demo не пришёл за 5 с");
  expect(openedDuringSleep).toStrictEqual([0, 0, 0]);
  expect(open).toBe(0);
});
