/**
 * Равенство строки и нынешнего CLI (`platform/registry-objects.md`,
 * инвариант первый): одна и та же строка через `runCli` и через
 * `runLine` с одними подменами даёт равные stdout, stderr, код и запись
 * журнала. Эталон — живой `runCli` в том же прогоне, а не записанный
 * текст: сверяется поведение, а не его снимок.
 */

import { assertEquals } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import { type InvokeJournal, runCli } from "../entrypoint/mod.ts";
import type { CliEntry } from "../process/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";

/** Что наблюдает вызывающий: потоки, код и отметки журнала. */
interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly journal: readonly string[];
}

async function seen(
  entry: CliEntry,
  argv: readonly string[],
  overrides: Partial<CommandIo>,
): Promise<Seen> {
  const out: string[] = [];
  const err: string[] = [];
  const journal: string[] = [];
  const log = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void journal.push(`native ${command.path.join(" ")}`),
    note: (line: string) => void journal.push(`note ${line}`),
  };
  const code = await entry(argv, makeFakeIo(overrides), {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }, log as unknown as InvokeJournal);
  return { code, stdout: out.join(""), stderr: err.join(""), journal };
}

/** Окружение `mpu ssh`: терминал и приёмник вывода удалённой команды. */
const SSH_IO: Partial<CommandIo> = {
  stdinIsTerminal: () => true,
  openRemoteOutput: () => ({
    out: () => Promise.resolve(),
    err: () => Promise.resolve(),
    captured: () => "",
  }),
};

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

/**
 * Случай сверки: `argv` — прежняя запись для `runCli`; у ключевой
 * команды строка набирается ключами (`line`), и сверяется она с тем же
 * исполнением в прежней записи (`platform/line-grammar.md`).
 */
const LINES: readonly {
  readonly argv: readonly string[];
  readonly line?: readonly string[];
  readonly io?: Partial<CommandIo>;
}[] = [
  { argv: ["version"] },
  { argv: ["version", "extra"] },
  { argv: ["xlsx", "alias", "ls", "--json"] },
  { argv: ["xlsx", "--json", "alias", "ls"] },
  { argv: ["xlsx", "get", "--", "--json"] },
  {
    // `end json` — прежний `--json` после имени команды: у `sql-ro` он
    // свой (`specs/sql-ro.md`), а не общий JSON результата.
    argv: ["sql-ro", "sl-1", "SELECT 1", "--dry", "--json"],
    line: [
      "sql-ro",
      "target:",
      "sl-1",
      "sql:",
      "SELECT 1",
      "--dry",
      GRAMMAR.close,
      "json",
    ],
    io: SQL_IO,
  },
  {
    argv: ["sql-ro", "sw", "select 1"],
    line: ["sql-ro", "target:", "sw", "sql:", "select 1"],
  },
  { argv: ["ssh", "sl-1", "--json"], io: SSH_IO },
  { argv: ["ssh", "sl-1", "--", "ls", "--help"], io: SSH_IO },
  { argv: ["ozon-jobs", "sl-2", "show", "--нет-флага"] },
  { argv: ["ozon-jobs", "show", "sl-2"] },
  { argv: ["ozon-jobs", "-p", "sl-2", "show", "--нет-флага"] },
  { argv: ["ss-update"] },
  { argv: ["telegram", "send"] },
  { argv: ["update"] },
  { argv: ["backup-wb-unit-proto", "777", "--date", "не-дата", "--dry"] },
  { argv: ["kiten", "card", "123"], line: ["kiten", "card", "id:", "123"] },
];

// Правила подтверждения дают `allow` любой строке: сравнивается
// исполнение, а решение правил проверяют свои тесты (`policy_test.ts`).
Deno.test("строка и runCli дают одно и то же", (t) =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const runLine = lineEntry(consentOf(file));
    for (const line of LINES) {
      await t.step(line.argv.join(" "), async () => {
        const io = line.io ?? {};
        assertEquals(
          await seen(runLine, line.line ?? line.argv, io),
          await seen(runCli, line.argv, io),
        );
      });
    }
  }));
