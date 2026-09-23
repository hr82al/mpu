/**
 * Выражение на месте значения и `stdin` (`platform/value-expression.md`,
 * «Граничные случаи»): группа вычисляется до сообщения ровно один раз,
 * годится ли результат значением — решают данные, stdin читается один
 * раз, вопрос — на каждую запись в момент, когда до неё дошло вычисление.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
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

Deno.test("сценарий 1: ask — вопрос с вычисленным значением, группа один раз", () =>
  withPolicyFile(async (file) => {
    const line = ["ask", "kiten", "comment", "id:", "1", "text:"];
    const answered = await run(file, [...line, DO, "jsdate", END], {
      answers: ["y"],
    });
    assertEquals(
      answered.called.filter((path) => path === "jsdate").length,
      1,
    );
    const asked = /выполнить mpu kiten comment id: 1 text: (\d{14})\? /.exec(
      answered.stderr,
    );
    assert(asked !== null, answered.stderr);
    assertEquals(answered.called, ["jsdate", "kiten comment"]);
  }));

Deno.test("сценарий 2: не-скаляр — отказ, ничего не исполнено", async (t) => {
  await withPolicyFile(async (file) => {
    allowEverything(file);
    for (
      const [group, kind] of [[["policy"], "список"], [
        ["sun"],
        "запись",
      ]] as const
    ) {
      await t.step(group.join(" "), async () => {
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
        assertEquals(got.code, 2);
        assertEquals(
          got.stderr,
          `mpu kiten comment: значение ключа text — не скаляр (${kind})\n`,
        );
        assertFalse(got.called.includes("kiten comment"));
      });
    }
  });
});

Deno.test("группа печатает не JSON — «не данные», внешнее не исполнено", () =>
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
    assertEquals(got.code, 2);
    assertEquals(
      got.stderr,
      "mpu kiten comment: значение ключа text — не данные\n",
    );
    assertFalse(got.called.includes("kiten comment"));
  }));

Deno.test("сценарий 3: отказ группы — отказ строки, внешнее не исполнено", () =>
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
    assertEquals(got.code, 2);
    assertEquals(got.stderr, "mpu: не понимает nope; ближайшие: code\n");
    assertEquals(got.called, []);
  }));

Deno.test("сценарий 4: sql: stdin — как прежде без sql:", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const stdin = "select 1\n";
    const keyed = await run(
      file,
      ["sql-ro", "target:", "sl-1", "sql:", STDIN, "--dry"],
      { stdin, io: SQL_IO },
    );
    const before = await run(file, ["sql-ro", "target:", "sl-1", "--dry"], {
      stdin,
      io: SQL_IO,
    });
    assertEquals(keyed.code, 0, keyed.stderr);
    assertEquals(keyed.stdout, before.stdout);
    assertEquals(keyed.reads, 1);
  }));

Deno.test("сценарий 5: stdin дважды — отказ до исполнения", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      ["mr", "create", "title:", STDIN, "into:", "main", "text:", STDIN],
      { stdin: "x\n" },
    );
    assertEquals(got.code, 2);
    assertEquals(
      got.stderr,
      "mpu mr create: stdin уже прочитан ключом title\n",
    );
    assertEquals(got.called, []);
  }));

Deno.test("stdin взят ключом — команда сама его не читает", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      ["sql-ro", "target:", STDIN, "--dry"],
      { stdin: "sl-1\n", io: SQL_IO },
    );
    assertEquals(got.code, 2, got.stderr);
    assertEquals(got.stderr, "mpu sql-ro: stdin уже прочитан ключом target\n");
    assertEquals(got.reads, 1);
  }));

Deno.test("сценарий 6: -- stdin — слово stdin", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      ["sql-ro", "target:", "sl-1", "sql:", LITERAL, STDIN, "--dry"],
      { io: SQL_IO },
    );
    assertEquals(got.code, 0, got.stderr);
    // `--dry` печатает запрос мета-блоком в stderr.
    assert(got.stderr.endsWith(`sql:\n${STDIN}\n`), got.stderr);
    assertEquals(got.reads, 0);
  }));

Deno.test("stdin — терминал: sql оставлен команде, прочие — отказ", () =>
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
    assertEquals(comment.code, 2);
    assertEquals(comment.stderr, "mpu kiten comment: stdin — терминал\n");
    assertEquals(comment.called, []);
    const keyed = await run(
      file,
      ["sql-ro", "target:", "sl-1", "sql:", STDIN, "--dry"],
      { io: SQL_IO },
    );
    const before = await run(file, ["sql-ro", "target:", "sl-1", "--dry"], {
      io: SQL_IO,
    });
    assertEquals([keyed.code, keyed.stdout], [before.code, before.stdout]);
  }));

Deno.test("сценарий 7: группа-запись в строке без ask — адресный отказ", () =>
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
    assertEquals(got.code, 2);
    assert(got.stderr.includes("требует подтверждения"), got.stderr);
    assertEquals(got.called, []);
  }));

Deno.test("ask: группа-запись спрашивает первой; «нет» — ничего не исполнено", () =>
  withPolicyFile(async (file) => {
    const got = await run(file, [
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
    ], { answers: ["n"] });
    assertEquals(got.code, 1);
    assertEquals(
      got.stderr,
      "выполнить mpu sql target: sl-1 sql: x? [y/N] " +
        "mpu sql target: sl-1 sql: x: не подтверждено\n",
    );
    assertEquals(got.called, []);
  }));

Deno.test("группа значения, затем формат внешнего результата", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(
      file,
      [
        "sql-ro",
        "target:",
        "sl-1",
        "sql:",
        DO,
        "jsdate",
        END,
        "--dry",
        END,
        "json",
      ],
      { io: SQL_IO },
    );
    assertEquals(got.code, 0, got.stderr);
    assertEquals(got.called, ["jsdate", "sql-ro"]);
    assert(/sql:\n\d{14}\n$/.test(got.stderr), got.stderr);
  }));

/** Чтение файлов — настоящее: книга лежит во временном каталоге. */
const FILES: Partial<CommandIo> = {
  readFile: (path) => Deno.readFile(path),
};

/** Копия `sample.xlsx` во временном каталоге. */
async function withSample(fn: (file: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    const b64 = await Deno.readTextFile(
      new URL("../xlsx/testdata/sample.xlsx.b64", import.meta.url),
    );
    const file = `${dir}/sample.xlsx`;
    await Deno.writeFile(
      file,
      Uint8Array.from(
        atob(b64.replaceAll(/\s+/g, "")),
        (ch) => ch.codePointAt(0) ?? 0,
      ),
    );
    await fn(file);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Диапазоны ячеек в ответе `xlsx get … end json`, по порядку. */
function rangesOf(stdout: string): string[] {
  const cells: { range: string }[] = JSON.parse(stdout).cells;
  return cells.map((cell) => cell.range);
}

Deno.test("ключ-список: stdin и группа — элементами, по порядку строки", () =>
  withPolicyFile(async (policy) => {
    allowEverything(policy);
    await withSample(async (file) => {
      const piped = await run(policy, [
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
      ], { stdin: "Данные!A1\n", io: FILES });
      assertEquals(piped.code, 0, piped.stderr);
      assertEquals(rangesOf(piped.stdout), ["Данные!A1", "Данные!B1"]);
      assertEquals(piped.reads, 1);

      const grouped = await run(policy, [
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
      ], { io: FILES });
      assertEquals(grouped.called, ["jsdate", "xlsx get"]);

      assert(/\d{14}/.test(grouped.stderr), grouped.stderr);
    });
  }));
