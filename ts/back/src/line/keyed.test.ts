/**
 * Команды-образцы на ключах (`platform/line-grammar.md`, «Команда-образец»,
 * «Отказы с подсказкой»): `kiten card`, `sql`, `sql-ro`. Исполнялась ли
 * команда — по отметке журнала; до БД и Kaiten строки не доходят.
 */

import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { makeFakeIo } from "@mpu/command/testing";
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
  const human =
    answers === undefined
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

describe("отказы с подсказкой по таблице спеки", () => {
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
        "есть: json, md, first, first:, isEmpty, last, last:, pick:, size, " +
        "sortBy:, where:",
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
        "-v; вариант — словом до ключей: mpu sql-ro verbose target: 54 " +
        'sql: "select 1"',
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
    // F11: отказ платформы, без префикса команды — как у `sql-ro` выше.
    [["telegram", "file", "chat:", "me"], "не хватает ключа id"],
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
  for (const [argv, stderr] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        expect(await run(file, argv)).toStrictEqual({
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      }),
    );
  }
});

it("--ключ значение — то же, что ключ: значение", () =>
  withPolicyFile(async (file) => {
    expect(
      await run(file, ["kiten", "card", "--id", "123", END, "xml"]),
    ).toStrictEqual(
      await run(file, ["kiten", "card", "id:", "123", END, "xml"]),
    );
  }));

it("ключи подряд — одно сообщение, строка исполняется", () =>
  withPolicyFile(async (file) => {
    const dry = await run(
      file,
      ["sql-ro", "dry", "target:", "sl-1", "sql:", "SELECT 1"],
      SQL_IO,
    );
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.called).toStrictEqual(["sql-ro"]);
    assert(dry.stderr.includes("sql:\nSELECT 1\n"), dry.stderr);
  }));

it("без sql: — запрос из stdin", () =>
  withPolicyFile(async (file) => {
    const stdin = await run(file, ["sql-ro", "dry", "target:", "sl-1"], {
      ...SQL_IO,
      readStdin: () => Promise.resolve(new TextEncoder().encode("select 2")),
    });
    expect(stdin.code, stdin.stderr).toBe(0);
    assert(stdin.stderr.includes("sql:\nselect 2\n"), stdin.stderr);
  }));

it("вопрос подтверждения — без формата", () =>
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
    expect((await run(file, line, {}, ["n"])).stderr).toStrictEqual(
      "выполнить mpu sql target: sl-1 sql: select 1? [y/N] " +
        "mpu sql target: sl-1 sql: select 1: не подтверждено\n",
    );
  }));

it("справка образца end json — ключи из объявления", () =>
  withPolicyFile(async (file) => {
    const help = await run(file, ["kiten", "card", "help", END, "json"]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.called).toStrictEqual([]);
    const data = JSON.parse(help.stdout);
    expect(data.keys[0].name).toBe("id");
    expect(data.keys[0].kind).toBe("value");
    expect(data.keys[0].required).toBe(true);
    expect(data.formats).toStrictEqual(["json", "md"]);
    expect(data.examples.length).toBe(4);
    expect(
      data.keys.map((key: { name: string }) => key.name).sort(),
    ).toStrictEqual(["id"]);
    expect(
      data.variants.map((line: { selector: string }) => line.selector),
    ).toStrictEqual(["no-comments", "no-images"]);
  }));

it("унарное за литералом — результату, как после end", () =>
  withPolicyFile(async (file) => {
    const line = ["sql-ro", "dry", "target:", "sl-1", "sql:", "SELECT 1"];
    const bare = await run(file, [...line, "json"], SQL_IO);
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.called).toStrictEqual(["sql-ro"]);
    expect(bare).toStrictEqual(await run(file, [...line, END, "json"], SQL_IO));
    const help = await run(file, ["kiten", "card", "id:", "123", "help"]);
    expect(help.code, help.stderr).toBe(0);
    expect(help.called).toStrictEqual([]);
    assert(
      help.stdout.startsWith(
        `Использование: mpu kiten card id: 123 ${END} <сообщение>\n\n` +
          "результат команды\n",
      ),
      help.stdout,
    );
  }));

it("telegram file без chat: — отказ до сети, голден (F10)", async () => {
  const golden = await readFile(
    new URL(
      "../telegram/testdata/telegram-file/err-no-chat-stderr.txt",
      import.meta.url,
    ),
    "utf8",
  );
  await withPolicyFile(async (file) => {
    expect(await run(file, ["telegram", "file", "id:", "42"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: golden,
      called: [],
    });
  });
});

it("telegram file id: не целое больше 0 — код 2 (F12)", () =>
  withPolicyFile(async (file) => {
    for (const raw of ["0", "abc"]) {
      const got = await run(file, [
        "telegram",
        "file",
        "chat:",
        "me",
        "id:",
        raw,
      ]);
      expect(got.code).toBe(2);
      expect(got.stdout).toBe("");
      expect(got.stderr).toStrictEqual(
        `mpu telegram file: id — целое больше 0: ${raw}\n`,
      );
    }
  }));
