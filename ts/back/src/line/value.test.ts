/**
 * Выражение на месте значения и `stdin` (`platform/value-expression.md`,
 * «Граничные случаи»): группа вычисляется до сообщения ровно один раз,
 * годится ли результат значением — решают данные, stdin читается один
 * раз, вопрос — на каждую запись в момент, когда до неё дошло вычисление.
 */

import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { makeFakeIo } from "@mpu/command/testing";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";

const { open: DO, close: END, literal: LITERAL, stdin: STDIN } = GRAMMAR;

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

/** Окружение, которого хватает `mpu sql-ro --dry`. */
const SQL_IO: Partial<CommandIo> = {
  envFile: {
    get: (name) => SQL_ENV[name],
    values: () => ({ ...SQL_ENV }),
    require: (name) => SQL_ENV[name] ?? "",
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  },
};

interface Run {
  readonly stdin?: string;
  readonly answers?: readonly string[];
  readonly io?: Partial<CommandIo>;
}

/** Строка у человека за терминалом stderr; stdin — из пайпа, если дан. */
async function run(file: string, argv: readonly string[], given: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  let reads = 0;
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const io = makeFakeIo({
    stdinIsTerminal: () => given.stdin === undefined,
    stderrIsTerminal: () => true,
    readStdin: () => {
      reads++;
      return Promise.resolve(new TextEncoder().encode(given.stdin ?? ""));
    },
    ...given.io,
  });
  const code = await lineEntry(consentOf(file, given.answers ?? []))(
    argv,
    io,
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called, reads };
}

it("сценарий 1: ask — вопрос с вычисленным значением, группа один раз", () =>
  withPolicyFile(async (file) => {
    const line = ["ask", "kiten", "comment", "id:", "1", "text:"];
    const answered = await run(file, [...line, DO, "jsdate", END], {
      answers: ["y"],
    });
    expect(answered.called.filter((path) => path === "jsdate").length).toBe(1);
    const asked = /выполнить mpu kiten comment id: 1 text: (\d{14})\? /.exec(
      answered.stderr,
    );
    assert(asked !== null, answered.stderr);
    expect(answered.called).toStrictEqual(["jsdate", "kiten comment"]);
  }));

describe("сценарий 2: не-скаляр — отказ, ничего не исполнено", () => {
  for (const [group, kind] of [
    [["policy"], "список"],
    [["sun"], "запись"],
  ] as const) {
    it(group.join(" "), () =>
      withPolicyFile(async (file) => {
        allowEverything(file);
        const got = await run(file, [
          "kiten",
          "comment",
          "id:",
          "1",
          "text:",
          DO,
          ...group,
          END,
        ]);
        expect(got.code).toBe(2);
        expect(got.stderr).toStrictEqual(
          `mpu kiten comment: значение ключа text — не скаляр (${kind})\n`,
        );
        expect(got.called.includes("kiten comment")).toBeFalsy();
      }),
    );
  }
});

it("группа печатает не JSON — «не данные», внешнее не исполнено", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(file, [
      "kiten",
      "comment",
      "id:",
      "1",
      "text:",
      DO,
      "version",
      END,
    ]);
    expect(got.code).toBe(2);
    expect(got.stderr).toBe(
      "mpu kiten comment: значение ключа text — не данные\n",
    );
    expect(got.called.includes("kiten comment")).toBeFalsy();
  }));

it("сценарий 3: отказ группы — отказ строки, внешнее не исполнено", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(file, [
      "kiten",
      "comment",
      "id:",
      DO,
      "nope",
      END,
      "text:",
      "x",
    ]);
    expect(got.code).toBe(2);
    expect(got.stderr).toBe("mpu: не понимает nope; ближайшие: code\n");
    expect(got.called).toStrictEqual([]);
  }));

it("сценарий 4: sql: stdin — как прежде без sql:", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const stdin = "select 1\n";
    const keyed = await run(
      file,
      ["sql-ro", "dry", "target:", "sl-1", "sql:", STDIN],
      { stdin, io: SQL_IO },
    );
    const before = await run(file, ["sql-ro", "dry", "target:", "sl-1"], {
      stdin,
      io: SQL_IO,
    });
    expect(keyed.code, keyed.stderr).toBe(0);
    expect(keyed.stdout).toStrictEqual(before.stdout);
    expect(keyed.reads).toBe(1);
  }));

it("сценарий 5: stdin дважды — отказ до исполнения", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      ["mr", "create", "title:", STDIN, "into:", "main", "text:", STDIN],
      { stdin: "x\n" },
    );
    expect(got.code).toBe(2);
    expect(got.stderr).toBe("mpu mr create: stdin уже прочитан ключом title\n");
    expect(got.called).toStrictEqual([]);
  }));

it("stdin взят ключом — команда сама его не читает", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(file, ["sql-ro", "dry", "target:", STDIN], {
      stdin: "sl-1\n",
      io: SQL_IO,
    });
    expect(got.code, got.stderr).toBe(2);
    expect(got.stderr).toBe("mpu sql-ro: stdin уже прочитан ключом target\n");
    expect(got.reads).toBe(1);
  }));

it("сценарий 6: -- stdin — слово stdin", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      ["sql-ro", "dry", "target:", "sl-1", "sql:", LITERAL, STDIN],
      { io: SQL_IO },
    );
    expect(got.code, got.stderr).toBe(0);
    // `--dry` печатает запрос мета-блоком в stderr.
    assert(got.stderr.endsWith(`sql:\n${STDIN}\n`), got.stderr);
    expect(got.reads).toBe(0);
  }));

it("stdin — терминал: sql оставлен команде, прочие — отказ", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const comment = await run(file, [
      "kiten",
      "comment",
      "id:",
      "1",
      "text:",
      STDIN,
    ]);
    expect(comment.code).toBe(2);
    expect(comment.stderr).toBe("mpu kiten comment: stdin — терминал\n");
    expect(comment.called).toStrictEqual([]);
    const keyed = await run(
      file,
      ["sql-ro", "dry", "target:", "sl-1", "sql:", STDIN],
      { io: SQL_IO },
    );
    const before = await run(file, ["sql-ro", "dry", "target:", "sl-1"], {
      io: SQL_IO,
    });
    expect([keyed.code, keyed.stdout]).toStrictEqual([
      before.code,
      before.stdout,
    ]);
  }));

it("сценарий 7: группа-запись в строке без ask — адресный отказ", () =>
  withPolicyFile(async (file) => {
    const got = await run(file, [
      "sql-ro",
      "target:",
      "sl-1",
      "sql:",
      DO,
      "sql",
      "target:",
      "sl-1",
      "sql:",
      "x",
      END,
    ]);
    expect(got.code).toBe(2);
    assert(got.stderr.includes("требует подтверждения"), got.stderr);
    expect(got.called).toStrictEqual([]);
  }));

it("ask: группа-запись спрашивает первой; «нет» — ничего не исполнено", () =>
  withPolicyFile(async (file) => {
    const got = await run(
      file,
      [
        "ask",
        "sql-ro",
        "target:",
        "sl-1",
        "sql:",
        DO,
        "sql",
        "target:",
        "sl-1",
        "sql:",
        "x",
        END,
      ],
      { answers: ["n"] },
    );
    expect(got.code).toBe(1);
    expect(got.stderr).toStrictEqual(
      "выполнить mpu sql target: sl-1 sql: x? [y/N] " +
        "mpu sql target: sl-1 sql: x: не подтверждено\n",
    );
    expect(got.called).toStrictEqual([]);
  }));

it("группа значения, затем формат внешнего результата", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      [
        "sql-ro",
        "dry",
        "target:",
        "sl-1",
        "sql:",
        DO,
        "jsdate",
        END,
        END,
        "json",
      ],
      { io: SQL_IO },
    );
    expect(got.code, got.stderr).toBe(0);
    expect(got.called).toStrictEqual(["jsdate", "sql-ro"]);
    assert(/sql:\n\d{14}\n$/.test(got.stderr), got.stderr);
  }));

/** Чтение файлов — настоящее: книга лежит во временном каталоге. */
const FILES: Partial<CommandIo> = {
  readFile: async (path) => new Uint8Array(await readFile(path)),
};

/** Копия `sample.xlsx` во временном каталоге. */
async function withSample(fn: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const file = `${dir}/sample.xlsx`;
    await copyFile(
      new URL("../../../docs/specs/fixtures/xlsx/sample.xlsx", import.meta.url),
      file,
    );
    await fn(file);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Диапазоны ячеек в ответе `xlsx get … end json`, по порядку. */
function rangesOf(stdout: string): string[] {
  const cells: { range: string }[] = JSON.parse(stdout).cells;
  return cells.map((cell) => cell.range);
}

it("ключ-список: stdin и группа — элементами, по порядку строки", () =>
  withPolicyFile(async (policy) => {
    allowEverything(policy);
    await withSample(async (file) => {
      const piped = await run(
        policy,
        [
          "xlsx",
          "get",
          "file:",
          file,
          "range:",
          STDIN,
          "range:",
          "Данные!B1",
          END,
          "json",
        ],
        { stdin: "Данные!A1\n", io: FILES },
      );
      expect(piped.code, piped.stderr).toBe(0);
      expect(rangesOf(piped.stdout)).toStrictEqual(["Данные!A1", "Данные!B1"]);
      expect(piped.reads).toBe(1);

      const grouped = await run(
        policy,
        [
          "xlsx",
          "get",
          "file:",
          file,
          "range:",
          DO,
          "jsdate",
          END,
          "range:",
          "Данные!B1",
        ],
        { io: FILES },
      );
      expect(grouped.called).toStrictEqual(["jsdate", "xlsx get"]);

      assert(/\d{14}/.test(grouped.stderr), grouped.stderr);
    });
  }));

it("деление: остаток отбору — ключ ввода с терминала не хватает, из пайпа — есть", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const line = ["sql-ro", "dry", "target:", "sl-1", "where:", "n", "is:"];
    const asked = await run(file, [...line, "1", END, "size"], {
      io: SQL_IO,
    });
    expect(asked.code).toBe(2);
    expect(asked.stderr).toBe("mpu sql-ro dry: не хватает ключа sql\n");
    expect(asked.called).toStrictEqual([]);
    for (const given of [
      { argv: [...line, "1", END, "size"], stdin: "select 1\n" },
      {
        argv: [
          "sql-ro",
          "dry",
          "target:",
          "sl-1",
          "sql:",
          "select 1",
          ...line.slice(4),
          "1",
          END,
          "size",
        ],
      },
    ]) {
      const got = await run(file, given.argv, {
        io: SQL_IO,
        stdin: given.stdin,
      });
      expect([got.code, got.stdout], got.stderr).toStrictEqual([0, "0\n"]);
      expect(got.called).toStrictEqual(["sql-ro"]);
    }
  }));

it("xlsx get from: - — stdin, взятый ключом, называется отказом строки", () =>
  withPolicyFile(async (policy) => {
    allowEverything(policy);
    await withSample(async (file) => {
      const got = await run(
        policy,
        ["xlsx", "get", "file:", file, "range:", STDIN, "from:", "-"],
        { stdin: "Данные!A1\n", io: FILES },
      );
      expect(got.code).toBe(2);
      expect(got.stderr).toBe("mpu xlsx: stdin уже прочитан ключом range\n");
    });
  }));
