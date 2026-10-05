/**
 * Строка `claude-hook pre-tool-use` в ядре (`claude-hook-pre-tool-use.md`,
 * «Сценарии», «Как находится решение»): эталон — копия
 * `fixtures/claude-hook-pre-tool-use/cases.json`; правила — посев на пустом
 * файле или файл-фикстура, где посев виден, а правила ровно перечисленные.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { HOOK_WORDS } from "../frames/mod.ts";
import { findCommand } from "../registry/mod.ts";
import {
  ALLOW,
  ASK,
  DENY,
  RuleBook,
  RulePath,
  type Verdict,
} from "../policy/mod.ts";
import { NO_INVOKE_LOG } from "../invokelog/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { Memory } from "./it.ts";
import { lineEntry, rulesOf } from "./mod.ts";
import { registrySeeds } from "./seeds.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";
import { type Ran, runOnStand, type Stand, withStand } from "./testprogram.ts";

/** Файл-фикстура: посев виден, правила — ровно `rules`. */
interface RuleSet {
  readonly seeded: string;
  readonly rules: readonly {
    readonly path: string;
    readonly verdict: string;
  }[];
}

interface HookCase {
  readonly id: string;
  readonly rules: "посев" | RuleSet;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  /** stdin целиком вместо payload'а. */
  readonly stdin?: string;
  readonly stdout: string;
  readonly stderr: string;
}

interface Golden {
  readonly cases: readonly HookCase[];
}

const VERDICTS: Readonly<Record<string, Verdict>> = {
  allow: ALLOW,
  ask: ASK,
  deny: DENY,
};

const testdata = (name: string) =>
  new URL(`testdata/claude-hook-pre-tool-use/${name}`, import.meta.url);

async function golden(): Promise<Golden> {
  return JSON.parse(await Deno.readTextFile(testdata("cases.json")));
}

async function livePayload(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await Deno.readTextFile(testdata("live-bash-mpu-version.json")),
  );
}

/** Правила сценария в файле `file`; «посев» — файл не трогается. */
function laid(file: string, rules: HookCase["rules"]) {
  if (rules === "посев") return;
  using book = RuleBook.open(file, registrySeeds());
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  for (const rule of rules.rules) {
    book.set(RulePath.parse(rule.path), VERDICTS[rule.verdict]);
  }
}

/** stdin сценария: живой payload с подменёнными полями или текст как есть. */
function stdinOf(one: HookCase, live: Record<string, unknown>): string {
  if (one.stdin !== undefined) return one.stdin;
  return JSON.stringify({
    ...live,
    tool_name: one.tool_name,
    tool_input: one.tool_input,
  });
}

/** stdin хука байтами; `read` — что ещё сделать при чтении. */
function hookIo(stdin: string, read: () => void = () => {}) {
  return {
    stdinIsTerminal: () => false,
    stderrIsTerminal: () => false,
    readStdin: () => {
      read();
      return Promise.resolve(new TextEncoder().encode(stdin));
    },
  };
}

/** Строка хука на стенде с файлом правил `file`. */
function hook(
  file: string,
  stand: Stand,
  stdin: string,
  read?: () => void,
): Promise<Ran> {
  return runOnStand(file, HOOK_WORDS, stand, { io: hookIo(stdin, read) });
}

Deno.test("сценарии cases.json: stdout, stderr, код 0", async (t) => {
  const { cases } = await golden();
  const live = await livePayload();
  await withStand(async (stand) => {
    for (const one of cases) {
      await t.step(one.id, () =>
        withPolicyFile(async (file) => {
          laid(file, one.rules);
          const ran = await hook(file, stand, stdinOf(one, live));
          assertEquals(
            { exit: ran.exit, stdout: ran.stdout, stderr: ran.stderr },
            { exit: 0, stdout: one.stdout, stderr: one.stderr },
          );
        }));
    }
  });
});

/** Сценарий эталона по номеру. */
function caseOf(cases: readonly HookCase[], id: string): HookCase {
  const one = cases.find((c) => c.id === id);
  if (one === undefined) throw new Error(`нет сценария ${id}`);
  return one;
}

Deno.test("E6, E7: значение-выражение не вычисляется — команда группы не вызвана", async () => {
  const { cases } = await golden();
  const live = await livePayload();
  await withStand(async (stand) => {
    for (const id of ["E6", "E7"]) {
      await withPolicyFile(async (file) => {
        const ran = await hook(file, stand, stdinOf(caseOf(cases, id), live));
        assertStringIncludes(ran.stderr, "решается при исполнении");
        assertEquals(stand.asked(), 0, "команда группы ушла в Kaiten");
        assertEquals([ran.native, ran.records], [[], []]);
      });
    }
  });
});

Deno.test("путь хука не allow: stdin не читается, отказ — текстом строки", async (t) => {
  const { cases } = await golden();
  const live = await livePayload();
  const stdin = stdinOf(caseOf(cases, "S1"), live);
  const unread = () => {
    throw new Error("stdin прочитан до согласия правил");
  };
  await withStand(async (stand) => {
    await t.step(
      "S20e: deny на пути хука",
      () =>
        withPolicyFile(async (file) => {
          allowAllBut(file, DENY);
          const ran = await hook(file, stand, stdin, unread);
          assertEquals([ran.exit, ran.stdout], [1, ""]);
          assertEquals(
            ran.stderr,
            "mpu claude-hook pre-tool-use: запрещено правилом «claude-hook pre-tool-use»\n",
          );
        }),
    );
    await t.step(
      "S20f: ask на пути хука, без человека",
      () =>
        withPolicyFile(async (file) => {
          allowAllBut(file, ASK);
          const ran = await hook(file, stand, stdin, unread);
          assertEquals([ran.exit, ran.stdout], [2, ""]);
          assert(
            ran.stderr.startsWith(
              "mpu claude-hook pre-tool-use: требует подтверждения",
            ),
            ran.stderr,
          );
        }),
    );
    await t.step(
      "S20b: policy.db — мусор",
      () =>
        withPolicyFile(async (file) => {
          await Deno.writeTextFile(file, "не SQLite, а мусор\n".repeat(64));
          const ran = await hook(file, stand, stdin, unread);
          assertEquals([ran.exit, ran.stdout], [1, ""]);
          assert(ran.stderr.startsWith("правила подтверждения: "), ran.stderr);
        }),
    );
  });
});

/** Посев снят, `*` — allow; на пути хука — `verdict`. */
function allowAllBut(file: string, verdict: Verdict) {
  using book = RuleBook.open(file, registrySeeds());
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), ALLOW);
  book.set(RulePath.parse(HOOK_WORDS.join(" ")), verdict);
}

/** Правило `kiten card` в файле, как его записал бы другой процесс. */
function ruleFromAside(file: string, verdict: Verdict) {
  using book = RuleBook.open(file, registrySeeds());
  book.set(RulePath.parse("kiten card"), verdict);
}

Deno.test("правило изменено другим процессом между вызовами", async (t) => {
  const { cases } = await golden();
  const live = await livePayload();
  const stdin = stdinOf(caseOf(cases, "S2"), live);
  await withStand(async (stand) => {
    await t.step(
      "следующий вызов хука видит новое правило",
      () =>
        withPolicyFile(async (file) => {
          assertStringIncludes(
            (await hook(file, stand, stdin)).stdout,
            "allow",
          );
          ruleFromAside(file, DENY);
          const ran = await hook(file, stand, stdin);
          assertStringIncludes(ran.stdout, '"permissionDecision":"deny"');
        }),
    );
    await t.step(
      "правило, записанное после решения пути хука, видно пробе",
      () =>
        withPolicyFile(async (file) => {
          const ran = await hook(
            file,
            stand,
            stdin,
            () => ruleFromAside(file, DENY),
          );
          assertEquals(
            ran.stdout,
            '{"hookSpecificOutput":{"hookEventName":"PreToolUse",' +
              '"permissionDecision":"deny","permissionDecisionReason":' +
              '"mpu kiten card: запрещено правилом «kiten card»"}}\n',
          );
        }),
    );
  });
});

/** Файл целиком байтами; нет файла — `null`. */
async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

Deno.test("хук не пишет: журнал, policy.db и кэш-БД не изменились", async () => {
  const { cases } = await golden();
  const live = await livePayload();
  await withStand(async (stand) => {
    await withPolicyFile(async (file) => {
      const cacheDir = await Deno.makeTempDir();
      const cache = `${cacheDir}/cache.db`;
      try {
        // Первое открытие сеет: это свойство любой строки, мерим после.
        RuleBook.open(file, registrySeeds())[Symbol.dispose]();
        const before = [await bytesOf(file), await bytesOf(cache)];
        for (const id of ["S1", "S5", "S9", "S16a", "E2", "E4", "E9"]) {
          const ran = await runOnStand(file, HOOK_WORDS, stand, {
            io: {
              ...hookIo(stdinOf(caseOf(cases, id), live)),
              openCacheDb: () => openCacheDb(cache),
            },
          });
          assertEquals([ran.exit, ran.native, ran.records], [0, [], []], id);
        }
        assertEquals([await bytesOf(file), await bytesOf(cache)], before);
      } finally {
        await Deno.remove(cacheDir, { recursive: true });
      }
    });
  });
});

Deno.test("методы корня двери и it в пробе не исполняются", async () => {
  const live = await livePayload();
  let produced = 0;
  let recalled = 0;
  const memory: Memory = {
    keep() {},
    recall: (absent) => {
      recalled++;
      return absent;
    },
    sliced: () => false,
  };
  await withPolicyFile(async (file) => {
    for (const words of [["web"], ["it"]]) {
      let stderr = "";
      const stdin = JSON.stringify({
        ...live,
        tool_name: "mcp__mpu__mpu",
        tool_input: { words },
      });
      const exit = await lineEntry({
        ...consentOf(file, [], memory),
        rootMethods: [{
          selector: "web",
          doc: { purpose: "вход в браузере", help: "Справка web." },
          produce: () => {
            produced++;
            return Promise.resolve({ url: "http://127.0.0.1/" });
          },
        }],
      })(
        HOOK_WORDS,
        makeFakeIo(hookIo(stdin)),
        { stdout: () => {}, stderr: (text) => void (stderr += text) },
        {
          nativeCall: () => {},
          note: () => {},
          executedBy: () => {},
          log: NO_INVOKE_LOG,
        },
      );
      assertEquals(
        [exit, stderr],
        [
          0,
          "mpu claude-hook pre-tool-use: без решения — правила строку не решают\n",
        ],
      );
    }
  });
  assertEquals({ produced, recalled }, { produced: 0, recalled: 0 });
});

Deno.test("справка: однострока, фрагмент настроек — как в эталоне", async () => {
  const command = findCommand(HOOK_WORDS);
  assert(command !== undefined);
  assertEquals(
    command.summary,
    "Какое решение правил mpu у вызова инструмента Claude Code?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  assertEquals(
    JSON.parse(fragment),
    JSON.parse(await Deno.readTextFile(testdata("settings-fragment.json"))),
  );
});

Deno.test("S23: посев на пустом файле — путь хука allow", () =>
  withPolicyFile((file) => {
    assert(
      rulesOf(file).some((rule) =>
        rule.path === "claude-hook pre-tool-use" && rule.verdict === "allow"
      ),
    );
    return Promise.resolve();
  }));

Deno.test("сбой книги при решении пробы — правила недоступны, код 0", async () => {
  const { cases } = await golden();
  const live = await livePayload();
  await withStand((stand) =>
    withPolicyFile(async (file) => {
      const ran = await hook(
        file,
        stand,
        stdinOf(caseOf(cases, "S1"), live),
        () => Deno.writeTextFileSync(file, "не SQLite\n".repeat(4096)),
      );
      assertEquals([ran.exit, ran.stdout], [0, ""]);
      assert(
        ran.stderr.startsWith(
          "mpu claude-hook pre-tool-use: без решения — правила недоступны: " +
            "правила подтверждения: ",
        ),
        ran.stderr,
      );
      assertEquals(ran.stderr.split("\n").length, 2, ran.stderr);
    })
  );
});

Deno.test("--json: источник строки — как у ядра", async (t) => {
  const live = await livePayload();
  // `--json run: x` — программа из файла; одно `--json` — не строка без
  // слов (`isBareLine`), ядро ведёт её цепочкой к справке.
  const cases = [
    [["--json", "run:", "x.mpu"], "программа: содержимое не видно"],
    [["--json"], "правила строку не решают"],
  ] as const;
  await withStand((stand) =>
    withPolicyFile(async (file) => {
      for (const [words, reason] of cases) {
        await t.step(words.join(" "), async () => {
          const ran = await hook(
            file,
            stand,
            JSON.stringify({
              ...live,
              tool_name: "mcp__mpu__mpu",
              tool_input: { words },
            }),
          );
          assertEquals(
            ran.stderr,
            `mpu claude-hook pre-tool-use: без решения — ${reason}\n`,
          );
        });
      }
    })
  );
});

Deno.test("строка хука в вызове — маршрут строки хука, а не обход цепочкой", async () => {
  const live = await livePayload();
  const calls = [
    {
      tool_name: "Bash",
      tool_input: { command: "mpu claude-hook pre-tool-use" },
    },
    { tool_name: "mcp__mpu__mpu", tool_input: { words: [...HOOK_WORDS] } },
  ];
  await withStand((stand) =>
    withPolicyFile(async (file) => {
      for (const call of calls) {
        const ran = await hook(
          file,
          stand,
          JSON.stringify({ ...live, ...call }),
        );
        assertEquals(
          { exit: ran.exit, stdout: ran.stdout, stderr: ran.stderr },
          {
            exit: 0,
            stdout: "",
            stderr:
              "mpu claude-hook pre-tool-use: без решения — решается при исполнении\n",
          },
          call.tool_name,
        );
      }
    })
  );
});
