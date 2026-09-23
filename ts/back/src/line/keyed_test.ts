/**
 * Команды-образцы на ключах (`platform/line-grammar.md`, «Команда-образец»,
 * «Отказы с подсказкой»): `kiten card`, `sql`, `sql-ro`. Исполнялась ли
 * команда — по отметке журнала; до БД и Kaiten строки не доходят.
 */

import { assert, assertEquals } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";

const END = GRAMMAR.close;

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

/** Окружение, которого хватает `mpu sql-ro … --dry`. */
const SQL_IO: Partial<CommandIo> = {
  envFile: {
    get: (name) => SQL_ENV[name],
    values: () => ({ ...SQL_ENV }),
    require: (name) => SQL_ENV[name] ?? "",
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  },
};

async function run(
  file: string,
  argv: readonly string[],
  io: Partial<CommandIo> = {},
  answers?: readonly string[],
) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const human = answers === undefined
    ? {}
    : { stdinIsTerminal: () => true, stderrIsTerminal: () => true };
  const code = await lineEntry(consentOf(file, answers))(
    argv,
    makeFakeIo({ ...io, ...human }),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

Deno.test("отказы с подсказкой по таблице спеки", async (t) => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["kiten", "card", "123"],
      "mpu kiten card: значение — ключом: mpu kiten card id: 123",
    ],
    [
      ["kiten", "card", "id:", "123", "--json"],
      "mpu kiten card id: 123: формат — сообщение результату: " +
      `mpu kiten card id: 123 ${END} json`,
    ],
    [
      ["--json", "kiten", "card", "id:", "123"],
      "mpu kiten card id: 123: формат — сообщение результату: " +
      `mpu kiten card id: 123 ${END} json`,
    ],
    [
      ["sql-ro", "target:", "54", "sql:", "select 1", END, "xml"],
      `mpu sql-ro target: 54 sql: select 1 ${END}: не понимает xml; ` +
      "есть: json, md, first, first:, isEmpty, last, pick:, size, sortBy:, " +
      "where:",
    ],
    [
      ["sql-ro", "sl-1", "select 1"],
      'mpu sql-ro: значение — ключом: mpu sql-ro target: sl-1 sql: "select 1"',
    ],
    [
      ["sql-ro", "target:", "sl-1", "--server", "sl-2"],
      "mpu sql-ro: --server снят — цель одна: target: sl-2",
    ],
    [
      ["sql-ro", "target:", "54", "sql:", "select 1", "-v"],
      "mpu sql-ro target: 54 sql: select 1: значение select 1 не понимает " +
      '-v; флаг — полным именем: mpu sql-ro target: 54 sql: "select 1" ' +
      "--verbose",
    ],
    [["kiten", "card"], "mpu kiten card: не хватает ключа id"],
    [
      ["kiten", "card", "id:", "123", "--md"],
      "mpu kiten card: формат — сообщение результату: " +
      `mpu kiten card id: 123 ${END} md`,
    ],
    [
      ["kiten", "card", "id:", "1", "nope:", "x"],
      "mpu kiten card id: 1: понимаю id:; nope: результат не понимает; " +
      "есть: json, md",
    ],
    [
      ["kiten", "card", "nope:", "x", "id:", "1"],
      "mpu kiten card: не понимает id:nope:",
    ],
    [["sql-ro", "sql:", "select 1"], "не хватает ключа target"],
    [
      ["sql-ro", "target:", "54", "sql:", "select 1", "limit:", "5"],
      "mpu sql-ro target: 54 sql: select 1: понимаю target:sql:; limit: " +
      "результат не понимает; есть: json, md",
    ],
    [
      ["kiten", "card", "id:", "1", GRAMMAR.open],
      `${GRAMMAR.open} — в начале строки или на месте значения`,
    ],
  ];
  await withPolicyFile(async (file) => {
    for (const [argv, stderr] of cases) {
      await t.step(argv.join(" "), async () => {
        assertEquals(await run(file, argv), {
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      });
    }
  });
});

Deno.test("--ключ значение — то же, что ключ: значение", () =>
  withPolicyFile(async (file) => {
    assertEquals(
      await run(file, ["kiten", "card", "--id", "123", END, "xml"]),
      await run(file, ["kiten", "card", "id:", "123", END, "xml"]),
    );
  }));

Deno.test("ключи подряд — одно сообщение, строка исполняется", () =>
  withPolicyFile(async (file) => {
    const dry = await run(
      file,
      ["sql-ro", "target:", "sl-1", "sql:", "SELECT 1", "--dry"],
      SQL_IO,
    );
    assertEquals(dry.code, 0, dry.stderr);
    assertEquals(dry.called, ["sql-ro"]);
    assert(dry.stderr.includes("sql:\nSELECT 1\n"), dry.stderr);
  }));

Deno.test("без sql: — запрос из stdin", () =>
  withPolicyFile(async (file) => {
    const stdin = await run(file, ["sql-ro", "target:", "sl-1", "--dry"], {
      ...SQL_IO,
      readStdin: () => Promise.resolve(new TextEncoder().encode("select 2")),
    });
    assertEquals(stdin.code, 0, stdin.stderr);
    assert(stdin.stderr.includes("sql:\nselect 2\n"), stdin.stderr);
  }));

Deno.test("вопрос подтверждения — без формата", () =>
  withPolicyFile(async (file) => {
    const line = [
      "ask",
      "sql",
      "target:",
      "sl-1",
      "sql:",
      "select 1",
      END,
      "json",
    ];
    assertEquals(
      (await run(file, line, {}, ["n"])).stderr,
      "выполнить mpu sql target: sl-1 sql: select 1? [y/N] " +
        "mpu sql target: sl-1 sql: select 1: не подтверждено\n",
    );
  }));

Deno.test("справка образца end json — ключи из объявления", () =>
  withPolicyFile(async (file) => {
    const help = await run(file, ["kiten", "card", "help", END, "json"]);
    assertEquals(help.code, 0, help.stderr);
    assertEquals(help.called, []);
    const data = JSON.parse(help.stdout);
    assertEquals(data.keys[0].name, "id");
    assertEquals(data.keys[0].kind, "value");
    assertEquals(data.keys[0].required, true);
    assertEquals(data.formats, ["json", "md"]);
    assertEquals(data.examples.length, 3);
    assertEquals(
      data.keys.map((key: { name: string }) => key.name).sort(),
      ["id", "no-comments", "no-images"],
    );
  }));

Deno.test("унарное за литералом — результату, как после end", () =>
  withPolicyFile(async (file) => {
    const line = ["sql-ro", "target:", "sl-1", "sql:", "SELECT 1", "--dry"];
    const bare = await run(file, [...line, "json"], SQL_IO);
    assertEquals(bare.code, 0, bare.stderr);
    assertEquals(bare.called, ["sql-ro"]);
    assertEquals(bare, await run(file, [...line, END, "json"], SQL_IO));
    const help = await run(file, ["kiten", "card", "id:", "123", "help"]);
    assertEquals(help.code, 0, help.stderr);
    assertEquals(help.called, []);
    assert(
      help.stdout.startsWith(
        `Использование: mpu kiten card id: 123 ${END} <сообщение>\n\n` +
          "результат команды\n",
      ),
      help.stdout,
    );
  }));
