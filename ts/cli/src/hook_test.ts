/**
 * Строка хука `PreToolUse` через тонкий клиент (`claude-hook-pre-tool-use.md`,
 * «Клиент»): код 0 при любом исходе ядра и окружения. Сервер из `back/`
 * поднимается только тестом; эталон — копия `cases.json` у `back/src/line`.
 */

import { assert, assertEquals } from "@std/assert";
import { HOOK_WORDS } from "../../back/src/frames/mod.ts";
import {
  ALLOW,
  ASK,
  DENY,
  RuleBook,
  RulePath,
  type Verdict,
} from "../../back/src/policy/mod.ts";
import { registrySeeds } from "../../back/src/line/seeds.ts";
import { type TestBack, withBack } from "../../back/src/backend/testback.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";

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
  return JSON.parse(await Deno.readTextFile(testdata("cases.json")));
}

/** stdin сценария `id`: живой payload с его `tool_name` и `tool_input`. */
async function payloadOf(id: string): Promise<string> {
  const one = (await golden()).cases.find((c) => c.id === id);
  if (one === undefined) throw new Error(`нет сценария ${id}`);
  const live = JSON.parse(
    await Deno.readTextFile(testdata("live-bash-mpu-version.json")),
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
  return viaClient(HOOK_WORDS, { base: back.url, main: back.token, stdin });
}

/** Исход сценария окружения: код, stdout и одна строка stderr. */
function assertEnv(seen: Seen, one: EnvCase) {
  assertEquals([seen.code, seen.stdout], [one.exit, one.stdout], one.id);
  if (one.stderr !== undefined) {
    assertEquals(seen.stderr, one.stderr, one.id);
    return;
  }
  assert(seen.stderr.startsWith(one.stderr_prefix ?? ""), seen.stderr);
  assertEquals(seen.stderr.split("\n").length, 2, seen.stderr);
}

/** Посев снят, `*` — allow; путь хука — `verdict`. */
function hookPathRuled(file: string, verdict: Verdict) {
  using book = RuleBook.open(file, registrySeeds());
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), ALLOW);
  book.set(RulePath.parse(HOOK_WORDS.join(" ")), verdict);
}

Deno.test("S1, S5 через клиент: ответ ядра как есть, код 0", async (t) => {
  const { cases } = await golden();
  for (const id of ["S1", "S5", "S19a"]) {
    const one = cases.find((c) => c.id === id);
    assert(one !== undefined);
    await t.step(id, () =>
      withBack(async (back) => {
        const stdin = one.tool_name === undefined
          ? "не json"
          : await payloadOf(id);
        assertEquals(await hookVia(back, stdin), {
          code: 0,
          stdout: one.stdout,
          stderr: one.stderr,
        });
        assertEquals(back.called, []);
      }));
  }
});

Deno.test("S20a: сервер строк не отвечает", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(closed.addr as Deno.NetAddr).port}`;
  closed.close();
  const seen = await viaClient(HOOK_WORDS, {
    base,
    main: "t",
    stdin: await payloadOf("S1"),
  });
  assertEnv(seen, await envCase("S20a"));
});

Deno.test("S20d: нет файла токена", async () => {
  const seen = await viaClient(HOOK_WORDS, {
    base: "http://127.0.0.1:1",
    stdin: await payloadOf("S1"),
  });
  assertEnv(seen, await envCase("S20d"));
});

Deno.test("S20b, S20c: файл правил не читается", async (t) => {
  const stdin = await payloadOf("S1");
  await t.step("S20b: мусор", () =>
    withBack(async (back) => {
      await Deno.writeTextFile(back.policyFile, "мусор\n".repeat(64));
      assertEnv(await hookVia(back, stdin), await envCase("S20b"));
    }));
  await t.step("S20c: без права чтения", () =>
    withBack(async (back) => {
      RuleBook.open(back.policyFile, registrySeeds())[Symbol.dispose]();
      await Deno.chmod(back.policyFile, 0o000);
      try {
        assertEnv(await hookVia(back, stdin), await envCase("S20c"));
      } finally {
        await Deno.chmod(back.policyFile, 0o600);
      }
    }));
});

Deno.test("S20e, S20f: путь хука не allow — правила недоступны, код 0", async (t) => {
  const stdin = await payloadOf("S1");
  for (const [id, verdict] of [["S20e", DENY], ["S20f", ASK]] as const) {
    await t.step(id, () =>
      withBack(async (back) => {
        hookPathRuled(back.policyFile, verdict);
        assertEnv(await hookVia(back, stdin), await envCase(id));
      }));
  }
});

Deno.test("S21: справка хука — обычная строка, код 0", async (t) => {
  for (const tail of ["--help", "help"]) {
    await t.step(tail, () =>
      withBack(async (back) => {
        const seen = await viaClient([...HOOK_WORDS, tail], {
          base: back.url,
          main: back.token,
        });
        assertEquals([seen.code, seen.stderr], [0, ""]);
        assert(
          seen.stdout.includes(
            "Какое решение правил mpu у вызова инструмента Claude Code?",
          ),
          seen.stdout,
        );
      }));
  }
});

Deno.test("слова сверх хука — обычная судьба: отказ строки и его код", () =>
  withBack(async (back) => {
    const seen = await viaClient([...HOOK_WORDS, "лишнее"], {
      base: back.url,
      main: back.token,
    });
    assertEquals([seen.code, seen.stdout], [2, ""]);
    assert(!seen.stderr.includes("без решения"), seen.stderr);
  }));
