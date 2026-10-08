/**
 * Протокол отражения на дереве строки (`platform/reflection.md`,
 * «Граничные случаи»): сообщения, ключи, форматы, значения `target:` и
 * дополнение `complete:` — без исполнения команды, вопроса и журнала.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";

const END = GRAMMAR.close;

/** Строка на свежих правилах; исполнение и журнал — шпионами. */
async function run(
  file: string,
  argv: readonly string[],
  io: Partial<CommandIo> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: (text: string) => void called.push(`note: ${text}`),
  } as unknown as InvokeJournal;
  // Человек у терминала с ответом «y»: спроси строка — она бы исполнилась.
  const code = await lineEntry(consentOf(file, ["y"]))(
    argv,
    makeFakeIo({
      stdinIsTerminal: () => true,
      stderrIsTerminal: () => true,
      ...io,
    }),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Кэш с двумя клиентами на двух серверах. */
async function withCache(body: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    using db = openCacheDb(path);
    db.bootstrap();
    for (const [id, title, server] of [
      [54, "Ромашка", "sl-2"],
      [7, "Лес", "sl-1"],
    ]) {
      db.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, 0)",
        id,
        server,
      );
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, 1, ?, 0)",
        `ss-${id}`,
        id,
        title,
        server,
      );
    }
    await body(path);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("протокол отражения: граничные случаи спеки", () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["kiten", "card", "keys"],
      "id\tvalue\tобязателен\tid карточки либо её URL, короткий или глубокий\n",
    ],
    [["sql-ro", "formats"], "json\nmd\n"],
    [["kiten", "understands:", "ls"], "true\n"],
    [["kiten", "understands:", "nope"], "false\n"],
    [["kiten", "card", "understands:", GRAMMAR.literal, "id:"], "true\n"],
    [["kiten", "card", "understands:", "no-images"], "true\n"],
    [
      ["kiten", "card", "variants"],
      "no-comments\tкомментарии карточки; не читать их — вариантом " +
        "no-comments\n" +
        "no-images\tвложения-картинки в наглядном виде; выключить — " +
        "вариантом no-images\n",
    ],
    [["kiten", "variants"], ""],
  ];
  for (const [argv, stdout] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        expect(await run(file, argv)).toStrictEqual({
          code: 0,
          stdout,
          stderr: "",
          called: [],
        });
      }),
    );
  }
});

it("keys end json — массив ключей с причинами", () =>
  withPolicyFile(async (file) => {
    const { stdout } = await run(file, ["sql-ro", "keys", END, "json"]);
    expect(
      JSON.parse(stdout).map((key: { name: string; reason: string | null }) => [
        key.name,
        key.reason,
      ]),
    ).toStrictEqual([
      ["target", null],
      ["sql", "прежнее имя входа"],
    ]);
  }));

it("messages kiten — по алфавиту, от boards до whoami", () =>
  withPolicyFile(async (file) => {
    const { stdout } = await run(file, ["kiten", "messages"]);
    const selectors = stdout
      .trimEnd()
      .split("\n")
      .map((row) => row.split("\t")[0]);
    expect(selectors[0]).toBe("boards");
    expect(selectors.at(-1)).toBe("whoami");
    expect(selectors).toStrictEqual([...selectors].sort());
  }));

describe("прежние имена протокола — отказ с готовой строкой", () => {
  for (const [argv, stderr] of [
    [
      ["kiten", "selectors"],
      "mpu kiten: selectors — теперь messages: mpu kiten messages",
    ],
    [
      ["kiten", "respondsTo:", "ls"],
      "mpu kiten: respondsTo — теперь understands: " +
        "mpu kiten understands: ls",
    ],
  ] as const) {
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

it("candidates: target — клиенты кэша по имени, с сервером", () =>
  withPolicyFile((file) =>
    withCache(async (cache) => {
      const io = { openCacheDb: () => openCacheDb(cache) };
      const { code, stdout, called } = await run(
        file,
        ["sql-ro", "candidates:", "target", "like:", "ром"],
        io,
      );
      expect(code).toBe(0);
      expect(stdout).toBe("54\tРомашка · sl-2\n");
      expect(called).toStrictEqual([]);
      const servers = await run(
        file,
        ["sql-ro", "candidates:", "target", "like:", "sl-"],
        io,
      );
      expect(servers.stdout).toBe("sl-1\tсервер\nsl-2\tсервер\n");
      const other = await run(
        file,
        ["sql-ro", "candidates:", "sql", "like:", "s"],
        io,
      );
      expect(other.stdout).toBe("");
    }),
  ));

describe("complete: — слова следующего шага", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["kiten ca", ["card"]],
    ["sql-ro target: 54 ", ["sql:"]],
    ["sql-ro ", ["dry", "target:", "verbose"]],
    ["sql-ro target: ром", ["54"]],
    [
      `kiten card id: 1 ${END} `,
      [
        "first",
        "first:",
        "isEmpty",
        "json",
        "last",
        "last:",
        "md",
        "pick:",
        "size",
        "sortBy:",
        "where:",
      ],
    ],
    ["kiten card ", ["id:", "no-comments", "no-images"]],
    ["kiten card no-images ", ["id:", "no-comments"]],
    [`kiten card id: 1 ${GRAMMAR.literal} `, []],
    ["kitn ", []],
  ];
  for (const [line, words] of cases) {
    it(line, () =>
      withPolicyFile((file) =>
        withCache(async (cache) => {
          const io = { openCacheDb: () => openCacheDb(cache) };
          const { code, stdout, called } = await run(
            file,
            ["complete:", line],
            io,
          );
          expect(code).toBe(0);
          expect(
            stdout
              .split("\n")
              .filter((row) => row !== "")
              .map((row) => row.split("\t")[0]),
          ).toStrictEqual([...words]);
          expect(called).toStrictEqual([]);
        }),
      ),
    );
  }
});

it("complete: через дверь — ключи; ни вопроса, ни исполнения, ни журнала", () =>
  withPolicyFile(async (file) => {
    const { code, stdout, stderr, called } = await run(file, [
      "complete:",
      "ask sql dry ",
    ]);
    expect(code).toBe(0);
    expect(
      stdout
        .split("\n")
        .filter((row) => row !== "")
        .map((row) => row.split("\t")[0]),
    ).toStrictEqual(["target:", "verbose"]);
    expect(stderr.includes("выполнить"), stderr).toBeFalsy();
    expect(called).toStrictEqual([]);
  }));
