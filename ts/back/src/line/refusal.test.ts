/**
 * Отказ — объект (`platform/refusal-object.md`): его текст равен stderr,
 * подсказка не ведёт в тот же отказ, у исполненной строки объекта нет.
 * Подсказка проверяется по дереву реестра с правилами, без исполнения.
 */

import { describe, expect, it } from "vitest";
import { BY_RULES } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import type { RefusalData } from "../frames/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { runChain } from "../objects/mod.ts";
import { NOBODY, RuleBook } from "../policy/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { registrySeeds } from "./seeds.ts";
import { Session } from "./session.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";
import { registryRoot } from "./tree.ts";
import { toDoor } from "./view.ts";

const END = GRAMMAR.close;

/** Строка через `mpu`: код, stderr и отказы-объекты, отданные вызывающему. */
async function run(file: string, argv: readonly string[]) {
  const err: string[] = [];
  const refusals: RefusalData[] = [];
  const code = await lineEntry({
    ...consentOf(file),
    refusal: (data) => void refusals.push(data),
  })(
    argv,
    makeFakeIo(),
    { stdout: () => {}, stderr: (text) => void err.push(text) },
    { nativeCall: () => {}, note: () => {} } as unknown as InvokeJournal,
  );
  return { code, stderr: err.join(""), refusals };
}

/**
 * Вид отказа строки `words` с правилами файла, без исполнения: дошедшая до
 * команды строка кончается кодом 0. Отказа нет — пусто.
 */
async function parsedReason(file: string, words: readonly string[]) {
  using book = RuleBook.open(file, registrySeeds());
  const reasons: string[] = [];
  const session = new Session({
    book,
    channel: NOBODY,
    output: {
      stdout: () => {},
      stderr: () => {},
      refusal: (data) => void reasons.push(data.reason),
    },
    dispatch: () => Promise.resolve(0),
    streams: () => false,
    consent: () => BY_RULES,
    terminal: false,
    redirect: () => toDoor(),
  });
  const outcome = await runChain(words, registryRoot(session, book));
  if ("refused" in outcome) reasons.push(outcome.refused.data().reason);
  return reasons.join(", ");
}

/** Виды отказа с готовой строкой: строка, которая его даёт. */
const HINTED: readonly (readonly [string, readonly string[]])[] = [
  ["значение без ключа", ["kiten", "comment", "55", "ok"]],
  ["формат флагом", ["kiten", "ls", "--md"]],
  [
    "короткий флаг",
    ["kiten", "comment", "id:", "55", "text:", "ok", "-m", "x"],
  ],
  ["snake_case", ["kiten", "ls", "--date_from", "2026-01-01"]],
  ["прежнее имя ключа", ["mr", "create", "--title", "t", "--target", "main"]],
  ["прежнее имя сообщения", ["kiten", "selectors"]],
  ["вариант после ключа", ["process", "target:", "54", END, "dry"]],
  ["вариант флагом", ["process", "target:", "54", "--dry-run"]],
  ["нужна дверь", ["sql", "target:", "sl-1", "sql:", "select 1"]],
  ["режим значением", ["logs", "ls"]],
  ["селектор перед подкомандой", ["ozon-jobs", "sl-2", "show"]],
  ["ближайшее унарное", ["kitn", "ls"]],
  ["ближайший ключ", ["kiten", "card", "idd:", "1"]],
  [
    "файл — ключом",
    [
      "api",
      "get-ss-values",
      "id:",
      "ss1",
      "body:",
      GRAMMAR.literal,
      `${GRAMMAR.variable}req.json`,
    ],
  ],
];

describe("у каждого вида с подсказкой: текст — stderr, hint — не тот же отказ", () => {
  for (const [kind, argv] of HINTED) {
    it(kind, () =>
      withPolicyFile(async (file) => {
        const got = await run(file, argv);
        expect(got.refusals.length, got.stderr).toBe(1);
        const [refusal] = got.refusals;
        expect(`${refusal.text}\n`).toStrictEqual(got.stderr);
        expect(refusal.hint, refusal.text).not.toStrictEqual(null);
        const again = await parsedReason(file, refusal.hint ?? []);
        expect(again, refusal.hint?.join(" ")).not.toStrictEqual(
          refusal.reason,
        );
      }),
    );
  }
});

describe("отказ без подсказки: hint null, текст — stderr", () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [["kiten", "spaces", "all", "all"], "отказ"],
    [
      ["sql-ro", "target:", "54", "sql:", "select 1", END, "xml"],
      "не понимает",
    ],
    [
      ["kiten", "card", "id:", "1", "do"],
      "do — в начале строки или на месте значения",
    ],
  ];
  for (const [argv, reason] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        const got = await run(file, argv);
        expect(got.code).toBe(2);
        expect(got.refusals.length, got.stderr).toBe(1);
        const [refusal] = got.refusals;
        expect(`${refusal.text}\n`).toStrictEqual(got.stderr);
        expect([refusal.reason, refusal.hint]).toStrictEqual([reason, null]);
      }),
    );
  }
});

it("исполненная строка отказа-объекта не даёт", async () => {
  await withPolicyFile(async (file) => {
    const got = await run(file, ["kiten", "help"]);
    expect([got.code, got.refusals]).toStrictEqual([0, []]);
  });
});

describe("сколько — limit: у всех «сколько» (long-output.md, §1)", () => {
  const cases: readonly (readonly [readonly string[], string, string[]])[] = [
    [
      ["logs", "target:", "sl-1", "tail:", "50"],
      "mpu logs: сколько — ключом: mpu logs target: sl-1 limit: 50",
      ["logs", "target:", "sl-1", "limit:", "50"],
    ],
    [
      ["log", "tail:", "5"],
      "mpu log: сколько — ключом: mpu log limit: 5",
      ["log", "limit:", "5"],
    ],
    [
      ["health", "target:", "sl-1", "tail:", "100"],
      "mpu health: сколько — ключом: mpu health target: sl-1 limit: 100",
      ["health", "target:", "sl-1", "limit:", "100"],
    ],
    [
      ["logs", "-n", "50"],
      "mpu logs: сколько — ключом: mpu logs limit: 50",
      ["logs", "limit:", "50"],
    ],
  ];
  for (const [argv, text, hint] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        const got = await run(file, argv);
        expect(got.code).toBe(2);
        expect(got.stderr).toStrictEqual(`${text}\n`);
        expect(got.refusals.map((one) => one.hint)).toStrictEqual([hint]);
      }),
    );
  }
});

it("файл значением — отказ с готовой строкой body-file:", () =>
  withPolicyFile(async (file) => {
    const got = await run(file, [
      "api",
      "get-ss-values",
      "id:",
      "ss1",
      "body:",
      GRAMMAR.literal,
      `${GRAMMAR.variable}req.json`,
    ]);
    expect(got.code).toBe(2);
    expect(got.stderr).toStrictEqual(
      "mpu api get-ss-values: файл — ключом: " +
        "mpu api get-ss-values id: ss1 body-file: req.json\n",
    );
    expect(got.refusals[0].hint).toStrictEqual([
      "api",
      "get-ss-values",
      "id:",
      "ss1",
      "body-file:",
      "req.json",
    ]);
  }));
