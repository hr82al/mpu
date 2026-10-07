/**
 * Отбор из результата (`platform/collection-protocol.md`): команда
 * исполняется один раз, отбор — сообщения данных, текст отобранного —
 * вид команды. Строки идут через точку входа строки на подменённом
 * Kaiten (петля) и настоящей кэш-БД во временном каталоге.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { AsideCall, runChain, SELECTABLE } from "../objects/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";

const { close: END, open: DO } = GRAMMAR;

const CARDS_PATH = "/api/latest/cards";

/** Четыре карточки: три в колонке 9101, даты активности по обе стороны 1.09. */
const CARDS: readonly Record<string, unknown>[] = [
  { id: 11, title: "один", state: 1, column_id: 9101, updated: "2026-08-20" },
  { id: 12, title: "два", state: 2, column_id: 9102, updated: "2026-09-05" },
  { id: 13, title: "три", state: 3, column_id: 9101, updated: "2026-08-01" },
  { id: 14, title: "четыре", state: 1, column_id: 9101, updated: "2026-09-10" },
];

/** Подменённый Kaiten и порт исполнения к нему. */
interface Stand {
  readonly io: Partial<CommandIo>;
  /** Сколько раз команда спросила карточки. */
  readonly asked: () => number;
}

async function withStand(fn: (stand: Stand) => Promise<void>) {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === "/api/latest/users/current") {
      return Response.json({ id: 9001, full_name: "Тест", username: "t" });
    }
    if (last.pathname !== CARDS_PATH) {
      return new Response("путь, которого тест не ждал", { status: 500 });
    }
    const offset = new URLSearchParams(last.search).get("offset");
    return Response.json(offset === "0" || offset === null ? CARDS : []);
  });
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  };
  try {
    await fn({
      io: {
        envFile: {
          get: (name) => values[name],
          values: () => values,
          require: (name) => values[name] ?? "",
          set: () => Promise.resolve(),
        },
        openCacheDb: () => openCacheDb(`${dir}/cache.db`),
      },
      asked: () =>
        fake.seen.filter((one) => one.pathname === CARDS_PATH).length,
    });
  } finally {
    await fake.stop();
    await rm(dir, { recursive: true });
  }
}

/** Строка у человека за терминалом; его ответы — `answers`. */
async function run(
  file: string,
  argv: readonly string[],
  stand: Stand,
  answers: readonly string[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const code = await lineEntry(consentOf(file, answers))(
    argv,
    makeFakeIo({
      ...stand.io,
      stdinIsTerminal: () => true,
      stderrIsTerminal: () => true,
    }),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Записи `kiten ls` целиком — прямым вызовом команды, без строки. */
async function rowsOf(stand: Stand): Promise<unknown[]> {
  const ls = findCommand(["kiten", "ls"]);
  assert(ls !== undefined);
  const result = await ls.invoke([], makeFakeIo(stand.io));
  return (result as { rows: unknown[] }).rows;
}

it("сценарий 1: size — число, команда исполнена один раз", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      await run(file, ["kiten", "ls"], stand);
      const once = stand.asked();
      const got = await run(file, ["kiten", "ls", END, "size"], stand);
      expect([got.code, got.stdout], got.stderr).toStrictEqual([0, "4\n"]);
      expect(got.called).toStrictEqual(["kiten ls"]);
      expect(stand.asked()).toStrictEqual(2 * once);
    })
  ));

it("сценарий 2: where: … is: и first: — JSON отобранных записей", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const rows = await rowsOf(stand);
      const expected = rows
        .filter((row) => (row as { column: string }).column === "9101")
        .slice(0, 2);
      const tail = ["first:", "2", END, "json"];
      for (
        const line of [
          ["kiten", "ls", "where:", "column", "is:", "9101", END, ...tail],
          ["kiten", "ls", END, "where:", "column", "is:", "9101", END, ...tail],
        ]
      ) {
        const got = await run(file, line, stand);
        expect(got.code, got.stderr).toBe(0);
        expect(got.stdout).toStrictEqual(
          `${JSON.stringify(expected, null, 2)}\n`,
        );
      }
    })
  ));

it("сценарий 3: sql-ro — строки записями, first n — значение", async () => {
  const sqlRo = findCommand(["sql-ro"]);
  assert(sqlRo !== undefined);
  const result = {
    server: "sl-1",
    host: "10.0.0.1",
    port: 5432,
    database: "mp",
    searchPath: null,
    sql: "select 1 as n",
    dry: false,
    outcome: { kind: "rows", columns: ["n"], rows: [[1]] },
  };
  const data = sqlRo.dataOf(result, ["sl-1", "select 1 as n"]);
  const origin = new AsideCall(
    "mpu",
    {
      purpose: "данные",
      help: "Данные результата.",
    },
    SELECTABLE.kind,
    () => data,
  );
  expect(await runChain(["first", "n"], origin)).toStrictEqual({
    path: [],
    value: "1\n",
  });
});

it("сценарий 4: нет поля — отказ с ближайшими, код 2", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const got = await run(file, ["kiten", "ls", END, "first", "nope"], stand);
      expect(got.code).toBe(2);
      expect(got.stderr).toStrictEqual(
        `mpu kiten ls ${END} first nope: запись не понимает nope; ` +
          "ближайшие: id, state, due_date, updated, title, url, column, " +
          "columnMapped\n",
      );
    })
  ));

it("сценарий 5: даты ISO — текстом", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const got = await run(file, [
        "kiten",
        "ls",
        "where:",
        "updated",
        "less:",
        "2026-09-01",
        END,
        "size",
      ], stand);
      expect([got.code, got.stdout], got.stderr).toStrictEqual([0, "2\n"]);
    })
  ));

it("сценарий 6: поток — только форматы, до исполнения", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const got = await run(
        file,
        ["logs", "follow", "target:", "sl-1", END, "size"],
        stand,
      );
      expect(got.code).toBe(2);
      expect(got.stderr).toStrictEqual(
        `mpu logs follow target: sl-1 ${END}: поток — только форматы\n`,
      );
      expect(got.called).toStrictEqual([]);
    })
  ));

it("сценарий 7: скаляр отбора — значение ключа", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      const got = await run(
        file,
        [
          "ask",
          "kiten",
          "comment",
          "id:",
          DO,
          "kiten",
          "ls",
          END,
          "first",
          "id",
          "text:",
          "ping",
        ],
        stand,
        ["n"],
      );
      // Вопрос — с вычисленным значением; «нет» — внешнее не исполнено.
      expect(got.called).toStrictEqual(["kiten ls"]);
      expect(got.stderr).toStrictEqual(
        "выполнить mpu kiten comment id: 11 text: ping? [y/N] " +
          "mpu kiten comment id: 11 text: ping: не подтверждено\n",
      );
    })
  ));

it("сценарий 8: текст отобранной коллекции — вид команды", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const plain = await run(file, ["kiten", "ls"], stand);
      const all = await run(file, ["kiten", "ls", END, "first:", "4"], stand);
      expect(all.stdout).toStrictEqual(plain.stdout);
      const rows = await rowsOf(stand);
      const ls = findCommand(["kiten", "ls"]);
      assert(ls !== undefined);
      const two = await run(file, ["kiten", "ls", END, "first:", "2"], stand);
      expect(two.code, two.stderr).toBe(0);
      expect(two.stdout).toStrictEqual(
        ls.renderResult({ view: "table", rows: rows.slice(0, 2) }, []),
      );
    })
  ));

it("значение-список записей с id — отказ с готовым значением", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const got = await run(file, [
        "kiten",
        "comment",
        "id:",
        DO,
        "kiten",
        "ls",
        END,
        "text:",
        "ping",
      ], stand);
      expect(got.code).toBe(2);
      expect(got.stderr).toStrictEqual(
        "mpu kiten comment: значение ключа id — не скаляр (список); " +
          `скаляром: id: ${DO} kiten ls ${END} first id\n`,
      );
      expect(got.called).toStrictEqual(["kiten ls"]);
    })
  ));

describe("граничные случаи отбора", () => {
  const cases: readonly (readonly [
    readonly string[],
    number,
    string,
    string,
  ])[] = [
    [
      ["kiten", "ls", END, "first:", "-1"],
      2,
      "",
      "first: -1 — ожидается n ≥ 0",
    ],
    [
      ["kiten", "ls", END, "sortBy:", "updated", END, "first", "title"],
      0,
      "три\n",
      "",
    ],
    [
      ["kiten", "ls", END, "where:", "id", "is:", "99", END, "first"],
      0,
      "\n",
      "",
    ],
    [
      [
        "kiten",
        "ls",
        END,
        "where:",
        "title",
        "includes:",
        "ДВ",
        END,
        "size",
      ],
      0,
      "1\n",
      "",
    ],
    [
      ["kiten", "ls", END, "where:", "id", "greater:", "12", END, "size"],
      0,
      "2\n",
      "",
    ],
    [["kiten", "ls", END, "pick:", "id", END, "last"], 0, "14\n", ""],
    [["kiten", "ls", END, "isEmpty"], 0, "false\n", ""],
    [["jsdate", END, "size"], 2, "", "скаляр не понимает size"],
    [["sql-ro", "where:", "n", "is:", "1"], 2, "", "не понимает is:where:"],
  ];
  for (const [line, code, stdout, refusal] of cases) {
    it(
      line.join(" "),
      () =>
        withPolicyFile((file) =>
          withStand(async (stand) => {
            allowEverything(file);
            const got = await run(file, line, stand);
            expect([got.code, got.stdout], got.stderr).toStrictEqual([
              code,
              stdout,
            ]);
            assert(
              got.stderr.endsWith(`${refusal}\n`) || refusal === "",
              got.stderr,
            );
            // Отбор идёт по готовому результату; до исполнения отказывает
            // только разбор ключей.
            if (line[0] === "sql-ro") expect(got.called).toStrictEqual([]);
          })
        ),
    );
  }
});

it("команда упала — отбора нет, код и отказ команды", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      // Карточки 1 подменённый Kaiten не знает: ответ 500.
      const line = ["kiten", "card", "id:", "1"];
      const plain = await run(file, line, stand);
      const got = await run(file, [...line, END, "size"], stand);
      expect(got).toStrictEqual({ ...plain, stdout: "" });
      assert(got.code !== 0, got.stderr);
    })
  ));

it("ответ протокола после end — только форматы", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      const got = await run(file, ["kiten", "messages", END, "size"], stand);
      expect(got.code).toBe(2);
      expect(got.stderr).toStrictEqual(
        `mpu kiten messages ${END}: не понимает size; есть: json\n`,
      );
    })
  ));
