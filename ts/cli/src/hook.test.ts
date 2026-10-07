/**
 * Строка хука `PreToolUse` через тонкий клиент (`claude-hook-pre-tool-use.md`,
 * «Клиент»): код 0 при любом исходе ядра и окружения. Сервер из `back/`
 * поднимается только тестом; эталон — копия `cases.json` у `back/src/line`.
 */

import { assert, beforeAll, describe, expect, it } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { PRE_TOOL_USE } from "../../back/src/frames/mod.ts";
import {
  ALLOW,
  ASK,
  DENY,
  RuleBook,
  RulePath,
  type Verdict,
} from "../../back/src/policy/mod.ts";
import { rulesOf } from "../../back/src/line/mod.ts";
import { type TestBack, withBack } from "../../back/src/backend/testback.ts";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer } from "./testkit.ts";
import { closedPort } from "../../back/src/testing/http.ts";

interface HookCase {
  readonly id: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly stdout: string;
  readonly stderr: string;
}

interface EnvCase {
  readonly id: string;
  readonly stdout: string;
  readonly stderr?: string;
  readonly stderr_prefix?: string;
  readonly exit: number;
}

interface Golden {
  readonly cases: readonly HookCase[];
  readonly environment: readonly EnvCase[];
}

const testdata = (name: string) =>
  new URL(
    `../../back/src/line/testdata/claude-hook-pre-tool-use/${name}`,
    import.meta.url,
  );

async function golden(): Promise<Golden> {
  return JSON.parse(await readFile(testdata("cases.json"), "utf8"));
}

/** stdin сценария `id`: живой payload с его `tool_name` и `tool_input`. */
async function payloadOf(id: string): Promise<string> {
  const one = (await golden()).cases.find((c) => c.id === id);
  if (one === undefined) throw new Error(`нет сценария ${id}`);
  const live = JSON.parse(
    await readFile(testdata("live-bash-mpu-version.json"), "utf8"),
  );
  return JSON.stringify({
    ...live,
    tool_name: one.tool_name,
    tool_input: one.tool_input,
  });
}

async function envCase(id: string): Promise<EnvCase> {
  const one = (await golden()).environment.find((c) => c.id === id);
  if (one === undefined) throw new Error(`нет сценария ${id}`);
  return one;
}

/** Что увидел вызывающий клиента. */
interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function viaClient(
  words: readonly string[],
  setup: { base: string; main?: string; stdin?: string },
): Promise<Seen> {
  const run = testEnv(setup);
  const code = await runClient(words, run.env);
  return { code, stdout: run.stdout.join(""), stderr: run.stderr.join("") };
}

function hookVia(back: TestBack, stdin: string): Promise<Seen> {
  return viaClient(PRE_TOOL_USE.words, {
    base: back.url,
    main: back.token,
    stdin,
  });
}

/** Исход сценария окружения: код, stdout и одна строка stderr. */
function assertEnv(seen: Seen, one: EnvCase) {
  expect([seen.code, seen.stdout], one.id).toStrictEqual([
    one.exit,
    one.stdout,
  ]);
  if (one.stderr !== undefined) {
    expect(seen.stderr, one.id).toStrictEqual(one.stderr);
    return;
  }
  assert(seen.stderr.startsWith(one.stderr_prefix ?? ""), seen.stderr);
  expect(seen.stderr.split("\n").length, seen.stderr).toBe(2);
}

/** Посев снят, `*` — allow; путь хука — `verdict`. */
function hookPathRuled(file: string, verdict: Verdict) {
  // Посев — открытием файла строкой; дальше книга без своего посева.
  rulesOf(file);
  using book = RuleBook.open(file, []);
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), ALLOW);
  book.set(RulePath.parse(PRE_TOOL_USE.words.join(" ")), verdict);
}

describe("S1, S5 через клиент: ответ ядра как есть, код 0", () => {
  let cases: readonly HookCase[] = [];
  beforeAll(async () => {
    ({ cases } = await golden());
  });
  for (const id of ["S1", "S5", "S19a"]) {
    it(id, () =>
      withBack(async (back) => {
        const one = cases.find((c) => c.id === id);
        assert(one !== undefined);
        const stdin =
          one.tool_name === undefined ? "не json" : await payloadOf(id);
        expect(await hookVia(back, stdin)).toStrictEqual({
          code: 0,
          stdout: one.stdout,
          stderr: one.stderr,
        });
        expect(back.called).toStrictEqual([]);
      }),
    );
  }
});

it("S20a: сервер строк не отвечает", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const seen = await viaClient(PRE_TOOL_USE.words, {
    base,
    main: "t",
    stdin: await payloadOf("S1"),
  });
  assertEnv(seen, await envCase("S20a"));
});

it("S20d: нет файла токена", async () => {
  const seen = await viaClient(PRE_TOOL_USE.words, {
    base: "http://127.0.0.1:1",
    stdin: await payloadOf("S1"),
  });
  assertEnv(seen, await envCase("S20d"));
});

describe("S20b, S20c: файл правил не читается", () => {
  let stdin = "";
  beforeAll(async () => {
    stdin = await payloadOf("S1");
  });
  it("S20b: мусор", () =>
    withBack(async (back) => {
      await writeFile(back.policyFile, "мусор\n".repeat(64));
      assertEnv(await hookVia(back, stdin), await envCase("S20b"));
    }));
  it("S20c: без права чтения", () =>
    withBack(async (back) => {
      rulesOf(back.policyFile);
      await chmod(back.policyFile, 0o000);
      try {
        assertEnv(await hookVia(back, stdin), await envCase("S20c"));
      } finally {
        await chmod(back.policyFile, 0o600);
      }
    }));
});

describe("S20e, S20f: путь хука не allow — правила недоступны, код 0", () => {
  let stdin = "";
  beforeAll(async () => {
    stdin = await payloadOf("S1");
  });
  for (const [id, verdict] of [
    ["S20e", DENY],
    ["S20f", ASK],
  ] as const) {
    it(id, () =>
      withBack(async (back) => {
        hookPathRuled(back.policyFile, verdict);
        assertEnv(await hookVia(back, stdin), await envCase(id));
      }),
    );
  }
});

describe("S21: справка хука — обычная строка, код 0", () => {
  for (const tail of ["--help", "help"]) {
    it(tail, () =>
      withBack(async (back) => {
        const seen = await viaClient([...PRE_TOOL_USE.words, tail], {
          base: back.url,
          main: back.token,
        });
        expect([seen.code, seen.stderr]).toStrictEqual([0, ""]);
        assert(
          seen.stdout.includes(
            "Какое решение правил mpu у вызова инструмента Claude Code?",
          ),
          seen.stdout,
        );
      }),
    );
  }
});

it("слова сверх хука — обычная судьба: отказ строки и его код", () =>
  withBack(async (back) => {
    const seen = await viaClient([...PRE_TOOL_USE.words, "лишнее"], {
      base: back.url,
      main: back.token,
    });
    expect([seen.code, seen.stdout]).toStrictEqual([2, ""]);
    assert(!seen.stderr.includes("без решения"), seen.stderr);
  }));

/** Сервер отвечает кадрами `frames` и закрывает сокет. */
function framed(...frames: readonly object[]): Script {
  return (socket) => {
    for (const frame of frames) socket.send(JSON.stringify(frame));
    socket.close(1000);
    return Promise.resolve();
  };
}

it("код ядра не 0: причина — первая строка кадров err как есть", () =>
  withFakeServer(
    async (base) => {
      expect(
        await viaClient(PRE_TOOL_USE.words, { base, main: "t" }),
      ).toStrictEqual({
        code: 0,
        stdout: "",
        stderr: PRE_TOOL_USE.undecided(
          PRE_TOOL_USE.unavailable("mpu: текст ядра"),
        ),
      });
    },
    {
      script: framed(
        { err: "mpu: текст ядра\nвторая\n" },
        { err: "другой кадр\n" },
        { exit: 1 },
      ),
    },
  ));

it("обрыв после кадра out: stdout пуст, одна строка без решения, код 0", () =>
  withFakeServer(
    async (base) => {
      expect(
        await viaClient(PRE_TOOL_USE.words, { base, main: "t" }),
      ).toStrictEqual({
        code: 0,
        stdout: "",
        stderr: PRE_TOOL_USE.undecided(
          PRE_TOOL_USE.unavailable("сервер оборвал строку"),
        ),
      });
    },
    { script: framed({ out: '{"hookSpecificOutput":{}}\n' }) },
  ));
