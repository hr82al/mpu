/**
 * Равенство `mpu-next` и нынешнего CLI (`platform/registry-objects.md`,
 * инвариант первый): одна и та же строка через `runCli` и через
 * `runNext` с одними подменами даёт равные stdout, stderr, код и запись
 * журнала. Эталон — живой `runCli` в том же прогоне, а не записанный
 * текст: сверяется поведение, а не его снимок.
 */

import { assertEquals } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import { type InvokeJournal, runCli } from "../entrypoint/mod.ts";
import type { CliEntry } from "../process/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { nextEntry } from "./mod.ts";
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

const LINES: readonly {
  readonly argv: readonly string[];
  readonly io?: Partial<CommandIo>;
}[] = [
  { argv: ["version"] },
  { argv: ["version", "extra"] },
  { argv: ["xlsx", "alias", "ls", "--json"] },
  { argv: ["xlsx", "--json", "alias", "ls"] },
  { argv: ["xlsx", "get", "--", "--json"] },
  { argv: ["--json", "sql-ro", "sl-1", "SELECT 1", "--dry"], io: SQL_IO },
  { argv: ["sql-ro", "sl-1", "SELECT 1", "--dry", "--dry"], io: SQL_IO },
  { argv: ["sql-ro", "sw", "select 1"] },
  { argv: ["ssh", "sl-1", "--json"], io: SSH_IO },
  { argv: ["ssh", "sl-1", "--", "ls", "--help"], io: SSH_IO },
  { argv: ["ozon-jobs", "sl-2", "show", "--нет-флага"] },
  { argv: ["ozon-jobs", "show", "sl-2"] },
  { argv: ["ozon-jobs", "-p", "sl-2", "show", "--нет-флага"] },
  { argv: ["mcp", "--port", "не-число"] },
  { argv: ["mcp", "port:", "1"] },
  { argv: ["ss-update"] },
  { argv: ["telegram", "send"] },
  { argv: ["update"] },
  { argv: ["backup-wb-unit-proto", "777", "--date", "не-дата", "--dry"] },
  { argv: ["kiten", "card", "123"] },
];

// Правила подтверждения дают `allow` любой строке: сравнивается
// исполнение, а решение правил проверяют свои тесты (`policy_test.ts`).
Deno.test("mpu-next и runCli дают одно и то же", (t) =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const runNext = nextEntry(consentOf(file));
    for (const line of LINES) {
      await t.step(line.argv.join(" "), async () => {
        const io = line.io ?? {};
        assertEquals(
          await seen(runNext, line.argv, io),
          await seen(runCli, line.argv, io),
        );
      });
    }
  }));
