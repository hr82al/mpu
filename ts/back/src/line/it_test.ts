/**
 * `it` — последний результат вызывающего (`platform/it.md`): строка
 * помнит результат для своего вызывающего, `it` рисует его заново и
 * отбирает из него, ничего не исполняя.
 */

import { assertEquals } from "@std/assert";
import type { Command, CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { LastResults, type Memory } from "./it.ts";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";

const END = GRAMMAR.close;

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

/** Окружение, которого хватает `mpu sql-ro --dry`: соединения нет. */
const SQL_IO: Partial<CommandIo> = {
  envFile: {
    get: (name) => SQL_ENV[name],
    values: () => ({ ...SQL_ENV }),
    require: (name) => SQL_ENV[name] ?? "",
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  },
};

const SQL = ["sql-ro", "target:", "sl-1", "sql:", "select 1 as n", "--dry"];

/** Строка вызывающего с памятью `memory`: вывод, код и исполненные. */
async function run(file: string, argv: readonly string[], memory: Memory) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const code = await lineEntry(consentOf(file, [], memory))(
    argv,
    makeFakeIo(SQL_IO),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Часы теста: время двигает сам тест. */
function clock() {
  let now = 0;
  return { now: () => now, pass: (ms: number) => void (now += ms) };
}

Deno.test("сценарий 1: it json — тот же результат, команда не исполнена", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const results = new LastResults(clock().now);
    const json = await run(file, [...SQL, END, "json"], results.of("ppid:1"));
    assertEquals(json.called, ["sql-ro"]);
    const plain = await run(file, SQL, results.of("ppid:1"));
    const stamp = await run(
      file,
      ["jsdate", END, "json"],
      results.of("ppid:3"),
    );
    const again = await run(file, ["it", "json"], results.of("ppid:3"));
    assertEquals(again.stdout, stamp.stdout);
    assertEquals(again.stdout.includes("stamp"), true, again.stdout);
    for (
      const [words, expected] of [
        [["it", "json"], json.stdout],
        [["it"], plain.stdout],
        [["it", END, "json"], json.stdout],
      ] as const
    ) {
      const got = await run(file, words, results.of("ppid:1"));
      assertEquals([got.code, got.stdout], [0, expected], got.stderr);
      assertEquals(got.called, []);
    }
  }));

Deno.test("сценарий 2: нет прошлого результата — отказ кодом 1", async (t) => {
  await withPolicyFile(async (file) => {
    const results = new LastResults(clock().now);
    for (const caller of ["ppid:1", undefined]) {
      await t.step(String(caller), async () => {
        const got = await run(file, ["it", "json"], results.of(caller));
        assertEquals(got, {
          code: 1,
          stdout: "",
          stderr: "mpu it: нет прошлого результата у этого вызывающего\n",
          called: [],
        });
      });
    }
  });
});

Deno.test("сценарий 3: отказ не заменяет прошлый результат, it отбирает", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const results = new LastResults(clock().now);
    await run(file, SQL, results.of("ppid:1"));
    const nope = await run(file, ["nope"], results.of("ppid:1"));
    assertEquals(nope.code, 2);
    // Ключа Kaiten в окружении нет: команда падает, не выходя в сеть.
    const failed = await run(
      file,
      ["kiten", "card", "id:", "1"],
      results.of("ppid:1"),
    );
    assertEquals(failed.code !== 0, true, failed.stderr);
    // Результат доставлен, но с кодом ≠ 0: помнить его нельзя.
    const coded = await run(file, ["xlsx", "resolve"], results.of("ppid:1"));
    assertEquals([coded.code, coded.called], [2, ["xlsx resolve"]]);
    const got = await run(file, ["it", "size"], results.of("ppid:1"));
    assertEquals([got.code, got.stdout], [0, "0\n"], got.stderr);
    const twice = await run(file, ["it", "size"], results.of("ppid:1"));
    assertEquals(twice.stdout, "0\n");
  }));

Deno.test("сценарий 4: результат одного вызывающего не виден другому", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const results = new LastResults(clock().now);
    await run(file, SQL, results.of("mcp:A"));
    const other = await run(file, ["it"], results.of("mcp:B"));
    assertEquals(other.code, 1);
    const own = await run(file, ["it"], results.of("mcp:A"));
    assertEquals(own.code, 0, own.stderr);
  }));

Deno.test("сценарий 5: новая память (перезапуск back) и час без строк — пусто", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const time = clock();
    const results = new LastResults(time.now);
    await run(file, SQL, results.of("ppid:1"));
    const restarted = await run(
      file,
      ["it"],
      new LastResults(time.now).of("ppid:1"),
    );
    assertEquals(restarted.code, 1);
    time.pass(60 * 60 * 1000);
    assertEquals((await run(file, ["it"], results.of("ppid:1"))).code, 0);
    time.pass(60 * 60 * 1000 + 1);
    assertEquals((await run(file, ["it"], results.of("ppid:1"))).code, 1);
  }));

Deno.test("сценарий 6: поток не запоминается, значение — да", () => {
  const logs = findCommand(["logs"]);
  const jsdate = findCommand(["jsdate"]);
  if (logs === undefined || jsdate === undefined) throw new Error("нет команд");
  const kept: string[] = [];
  const keeper = {
    keep: (command: Command) => void kept.push(command.path.join(" ")),
  };
  logs.remember({}, ["--follow"], keeper);
  jsdate.remember({ stamp: "20260923000000" }, [], keeper);
  assertEquals(kept, ["jsdate"]);
});

Deno.test("it: формат команды — её рендер с прежними аргументами", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const results = new LastResults(clock().now);
    await run(file, SQL, results.of("ppid:1"));
    const md = await run(file, [...SQL, END, "md"], results.of("ppid:2"));
    const got = await run(file, ["it", "md"], results.of("ppid:1"));
    assertEquals([got.code, got.stdout], [0, md.stdout], got.stderr);
    const closed = await run(file, ["it", "md", END], results.of("ppid:1"));
    assertEquals(closed.stdout, md.stdout);
    const last = await run(file, ["it", "md", "size"], results.of("ppid:1"));
    assertEquals(
      [last.code, last.stderr],
      [2, "mpu it md: не понимает size; формат — последним\n"],
    );
    const refused = await run(file, ["it", "xml"], results.of("ppid:1"));
    assertEquals(refused.code, 2);
    assertEquals(
      refused.stderr,
      "mpu it: не понимает xml; есть: json, md, first, first:, isEmpty, " +
        "last, pick:, size, sortBy:, where:\n",
    );
  }));
