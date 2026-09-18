/**
 * Клиент и `back/next.ts` дают одно и то же (`cli-client.md`,
 * «Инварианты», «Golden-примеры»): одни слова, правила и ответ — через
 * тонкий клиент к серверу в процессе теста и через `nextEntry` с теми же
 * правилами, каналом и окружением строки. Сервер из `back/` поднимается
 * только тестом: код `cli/` берёт из `back/` лишь контракт кадров.
 */

import { assertEquals } from "@std/assert";
import type { CommandIo } from "../../back/src/command/mod.ts";
import type { InvokeJournal } from "../../back/src/entrypoint/mod.ts";
import { immediately, nextEntry, rulesOf } from "../../back/src/next/mod.ts";
import { withPolicyFile } from "../../back/src/next/testconsent.ts";
import {
  Agent,
  type Channel,
  Human,
  NOBODY,
} from "../../back/src/policy/mod.ts";
import { makeFakeIo } from "../../back/src/testing/mod.ts";
import { type TestBack, withBack } from "../../back/src/backend/testback.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";

/** Как клиент стоит к серверу: какой токен у него есть и есть ли человек. */
type Stance = "terminal" | "pipe" | "agent";

interface Line {
  readonly words: readonly string[];
  readonly stance: Stance;
  readonly answers?: readonly string[];
  readonly io?: Partial<CommandIo>;
}

const SQL_ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

const SQL_IO: Partial<CommandIo> = {
  envFile: {
    get: (name) => SQL_ENV[name],
    values: () => ({ ...SQL_ENV }),
    require: (name) => SQL_ENV[name] ?? "",
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  },
};

const LINES: readonly Line[] = [
  // Таблица граничных случаев спеки.
  { words: ["version"], stance: "pipe" },
  { words: ["kitn"], stance: "pipe" },
  { words: ["allow:", "kiten ls"], stance: "terminal", answers: ["y"] },
  { words: ["allow:", "kiten ls"], stance: "terminal", answers: ["n"] },
  { words: ["allow:", "kiten ls"], stance: "agent" },
  // Строки парного теста порции 139, не читающие stdin.
  { words: ["version", "extra"], stance: "pipe" },
  { words: ["xlsx", "alias", "ls", "--json"], stance: "pipe" },
  { words: ["xlsx", "--json", "alias", "ls"], stance: "pipe" },
  { words: ["xlsx", "get", "--", "--json"], stance: "pipe" },
  {
    words: ["--json", "sql-ro", "sl-1", "SELECT 1", "--dry"],
    stance: "pipe",
    io: SQL_IO,
  },
  {
    words: ["sql-ro", "sl-1", "SELECT 1", "--dry", "--dry"],
    stance: "pipe",
    io: SQL_IO,
  },
  { words: ["sql-ro", "sw", "select 1"], stance: "pipe" },
  { words: ["ozon-jobs", "sl-2", "show", "--нет-флага"], stance: "pipe" },
  { words: ["ozon-jobs", "show", "sl-2"], stance: "pipe" },
  { words: ["mcp", "--port", "не-число"], stance: "pipe" },
  { words: ["mcp", "port:", "1"], stance: "pipe" },
  { words: ["ss-update"], stance: "pipe" },
  { words: ["telegram", "send"], stance: "pipe" },
  { words: ["update"], stance: "pipe" },
  {
    words: ["backup-wb-unit-proto", "777", "--date", "не-дата", "--dry"],
    stance: "pipe",
  },
  { words: ["kiten", "card", "123"], stance: "pipe" },
];

/** Итог, видимый вызывающему. */
interface Seen {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Канал `back/next.ts` при той же стойке: у сервера — тот же. */
function channelOf(
  stance: Stance,
  output: { stderr(text: string): void },
  answers: string[],
): Channel {
  if (stance === "agent") return new Agent(NOBODY);
  if (stance === "pipe") return NOBODY;
  return new Human(output.stderr, () => Promise.resolve(answers.shift()));
}

async function viaNext(line: Line, file: string): Promise<Seen> {
  const out: string[] = [];
  const err: string[] = [];
  const output = {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  };
  const channel = channelOf(line.stance, output, [...line.answers ?? []]);
  const journal = {
    nativeCall: () => {},
    note: () => {},
  } as unknown as InvokeJournal;
  // Строка у сервера видит потоки не-терминалами и пустой stdin — у
  // эталона то же окружение (`back-rpc.md`, «Известные отклонения»).
  const code = await nextEntry({
    file,
    channel: () => channel,
    execute: immediately,
    rootMethods: [],
  })(
    line.words,
    makeFakeIo(line.io ?? {}),
    output,
    journal,
  );
  return { stdout: out.join(""), stderr: err.join(""), code };
}

async function viaClient(line: Line, back: TestBack): Promise<Seen> {
  const run = testEnv({
    base: back.url,
    main: line.stance === "agent" ? undefined : back.token,
    agent: back.agentToken,
    terminals: line.stance === "terminal",
    answers: line.answers,
  });
  const code = await runClient(line.words, run.env);
  const seen = {
    stdout: run.stdout.join(""),
    stderr: run.stderr.join(""),
    code,
  };
  for (const token of [back.token, back.agentToken]) {
    assertEquals(
      JSON.stringify(seen).includes(token),
      false,
      "токен в выводе клиента",
    );
  }
  return seen;
}

Deno.test("клиент и back/next.ts дают одно и то же", async (t) => {
  for (const line of LINES) {
    const name = `${line.stance}: ${line.words.join(" ")} ${
      line.answers ?? ""
    }`;
    await t.step(name, () =>
      withPolicyFile((file) =>
        withBack(async (back) => {
          const expected = await viaNext(line, file);
          assertEquals(await viaClient(line, back), expected);
          assertEquals(rulesOf(back.policyFile), rulesOf(file));
        }, { io: line.io })
      ));
  }
});

Deno.test("правило без основного токена: отказ, файл не изменён", () =>
  withBack(async (back) => {
    rulesOf(back.policyFile);
    const before = await Deno.readFile(back.policyFile);
    const seen = await viaClient({
      words: ["allow:", "kiten ls"],
      stance: "agent",
    }, back);
    assertEquals(seen, {
      stdout: "",
      stderr: "изменить правила может только человек\n",
      code: 1,
    });
    assertEquals(await Deno.readFile(back.policyFile), before);
  }));
