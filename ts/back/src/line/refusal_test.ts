/**
 * Отказ — объект (`platform/refusal-object.md`): его текст равен stderr,
 * подсказка не ведёт в тот же отказ, у исполненной строки объекта нет.
 * Подсказка проверяется по дереву реестра с правилами, без исполнения.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
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
    terminal: false,
  });
  const outcome = await runChain(words, registryRoot(session, book));
  if ("refused" in outcome) reasons.push(outcome.refused.data().reason);
  return reasons.join(", ");
}

/** Виды отказа с готовой строкой: строка, которая его даёт. */
const HINTED: readonly (readonly [string, readonly string[]])[] = [
  ["значение без ключа", ["kiten", "comment", "55", "ok"]],
  ["формат флагом", ["kiten", "ls", "--md"]],
  ["короткий флаг", [
    "kiten",
    "comment",
    "id:",
    "55",
    "text:",
    "ok",
    "-m",
    "x",
  ]],
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
];

Deno.test("у каждого вида с подсказкой: текст — stderr, hint — не тот же отказ", async (t) => {
  await withPolicyFile(async (file) => {
    for (const [kind, argv] of HINTED) {
      await t.step(kind, async () => {
        const got = await run(file, argv);
        assertEquals(got.refusals.length, 1, got.stderr);
        const [refusal] = got.refusals;
        assertEquals(`${refusal.text}\n`, got.stderr);
        assertNotEquals(refusal.hint, null, refusal.text);
        const again = await parsedReason(file, refusal.hint ?? []);
        assertNotEquals(again, refusal.reason, refusal.hint?.join(" "));
      });
    }
  });
});

Deno.test("отказ без подсказки: hint null, текст — stderr", async (t) => {
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
  await withPolicyFile(async (file) => {
    for (const [argv, reason] of cases) {
      await t.step(argv.join(" "), async () => {
        const got = await run(file, argv);
        assertEquals(got.code, 2);
        assertEquals(got.refusals.length, 1, got.stderr);
        const [refusal] = got.refusals;
        assertEquals(`${refusal.text}\n`, got.stderr);
        assertEquals([refusal.reason, refusal.hint], [reason, null]);
      });
    }
  });
});

Deno.test("исполненная строка отказа-объекта не даёт", async () => {
  await withPolicyFile(async (file) => {
    const got = await run(file, ["kiten", "help"]);
    assertEquals([got.code, got.refusals], [0, []]);
  });
});

Deno.test("сколько — limit: у всех «сколько» (long-output.md, §1)", async (t) => {
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
  await withPolicyFile(async (file) => {
    for (const [argv, text, hint] of cases) {
      await t.step(argv.join(" "), async () => {
        const got = await run(file, argv);
        assertEquals(got.code, 2);
        assertEquals(got.stderr, `${text}\n`);
        assertEquals(got.refusals.map((one) => one.hint), [hint]);
      });
    }
  });
});
