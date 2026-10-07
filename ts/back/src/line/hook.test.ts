/**
 * Строка `claude-hook pre-tool-use` в ядре (`claude-hook-pre-tool-use.md`,
 * «Сценарии», «Как находится решение»): эталон — копия
 * `fixtures/claude-hook-pre-tool-use/cases.json`; правила — посев на пустом
 * файле или файл-фикстура, где посев виден, а правила ровно перечисленные.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import goldenCases from "./testdata/claude-hook-pre-tool-use/cases.json" with {
  type: "json",
};
import LIVE from "./testdata/claude-hook-pre-tool-use/live-bash-mpu-version.json" with {
  type: "json",
};
import { PRE_TOOL_USE } from "../frames/mod.ts";
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
import { openRegistryBook, registrySeeds } from "./seeds.ts";
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

/**
 * Эталон сценариев. Перечень нужен при сборе тестов, поэтому — импортом
 * JSON, а не чтением в теле; форма не проверяется, как и у прежнего
 * `JSON.parse` (строки JSON-импорта шире союзов `HookCase`).
 */
const GOLDEN = goldenCases as Golden;

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
  return runOnStand(file, PRE_TOOL_USE.words, stand, {
    io: hookIo(stdin, read),
  });
}

describe("сценарии cases.json: stdout, stderr, код 0", () => {
  const { cases } = GOLDEN;
  const live = LIVE;
  for (const one of cases) {
    it(one.id, () =>
      withStand(async (stand) => {
        await withPolicyFile(async (file) => {
          laid(file, one.rules);
          const ran = await hook(file, stand, stdinOf(one, live));
          expect({ exit: ran.exit, stdout: ran.stdout, stderr: ran.stderr })
            .toStrictEqual({ exit: 0, stdout: one.stdout, stderr: one.stderr });
        });
      }));
  }
});

/** Сценарий эталона по номеру. */
function caseOf(cases: readonly HookCase[], id: string): HookCase {
  const one = cases.find((c) => c.id === id);
  if (one === undefined) throw new Error(`нет сценария ${id}`);
  return one;
}

it("E6, E7: значение-выражение не вычисляется — команда группы не вызвана", async () => {
  const { cases } = GOLDEN;
  const live = LIVE;
  await withStand(async (stand) => {
    for (const id of ["E6", "E7"]) {
      await withPolicyFile(async (file) => {
        const ran = await hook(file, stand, stdinOf(caseOf(cases, id), live));
        expect(ran.stderr).toContain("решается при исполнении");
        expect(stand.asked(), "команда группы ушла в Kaiten").toBe(0);
        expect([ran.native, ran.records]).toStrictEqual([[], []]);
      });
    }
  });
});

describe("путь хука не allow: stdin не читается, отказ — текстом строки", () => {
  const { cases } = GOLDEN;
  const live = LIVE;
  const stdin = stdinOf(caseOf(cases, "S1"), live);
  const unread = () => {
    throw new Error("stdin прочитан до согласия правил");
  };
  it("S20e: deny на пути хука", () =>
    withStand(async (stand) => {
      await withPolicyFile(async (file) => {
        allowAllBut(file, DENY);
        const ran = await hook(file, stand, stdin, unread);
        expect([ran.exit, ran.stdout]).toStrictEqual([1, ""]);
        expect(ran.stderr).toBe(
          "mpu claude-hook pre-tool-use: запрещено правилом «claude-hook pre-tool-use»\n",
        );
      });
    }));
  it("S20f: ask на пути хука, без человека", () =>
    withStand(async (stand) => {
      await withPolicyFile(async (file) => {
        allowAllBut(file, ASK);
        const ran = await hook(file, stand, stdin, unread);
        expect([ran.exit, ran.stdout]).toStrictEqual([2, ""]);
        assert(
          ran.stderr.startsWith(
            "mpu claude-hook pre-tool-use: требует подтверждения",
          ),
          ran.stderr,
        );
      });
    }));
  it("S20b: policy.db — мусор", () =>
    withStand(async (stand) => {
      await withPolicyFile(async (file) => {
        await writeFile(file, "не SQLite, а мусор\n".repeat(64));
        const ran = await hook(file, stand, stdin, unread);
        expect([ran.exit, ran.stdout]).toStrictEqual([1, ""]);
        assert(ran.stderr.startsWith("правила подтверждения: "), ran.stderr);
      });
    }));
});

/** Посев снят, `*` — allow; на пути хука — `verdict`. */
function allowAllBut(file: string, verdict: Verdict) {
  using book = RuleBook.open(file, registrySeeds());
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), ALLOW);
  book.set(RulePath.parse(PRE_TOOL_USE.words.join(" ")), verdict);
}

/** Правило `kiten card` в файле, как его записал бы другой процесс. */
function ruleFromAside(file: string, verdict: Verdict) {
  using book = RuleBook.open(file, registrySeeds());
  book.set(RulePath.parse("kiten card"), verdict);
}

describe("правило изменено другим процессом между вызовами", () => {
  const { cases } = GOLDEN;
  const live = LIVE;
  const stdin = stdinOf(caseOf(cases, "S2"), live);
  it("следующий вызов хука видит новое правило", () =>
    withStand(async (stand) => {
      await withPolicyFile(async (file) => {
        expect((await hook(file, stand, stdin)).stdout).toContain("allow");
        ruleFromAside(file, DENY);
        const ran = await hook(file, stand, stdin);
        expect(ran.stdout).toContain('"permissionDecision":"deny"');
      });
    }));
  it("правило, записанное после решения пути хука, видно пробе", () =>
    withStand(async (stand) => {
      await withPolicyFile(async (file) => {
        const ran = await hook(
          file,
          stand,
          stdin,
          () => ruleFromAside(file, DENY),
        );
        expect(ran.stdout).toStrictEqual(
          '{"hookSpecificOutput":{"hookEventName":"PreToolUse",' +
            '"permissionDecision":"deny","permissionDecisionReason":' +
            '"mpu kiten card: запрещено правилом «kiten card»"}}\n',
        );
      });
    }));
});

/** Файл целиком байтами; нет файла — `null`. */
async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

it("хук не пишет: журнал, policy.db и кэш-БД не изменились", async () => {
  const { cases } = GOLDEN;
  const live = LIVE;
  await withStand(async (stand) => {
    await withPolicyFile(async (file) => {
      const cacheDir = await mkdtemp(join(tmpdir(), "mpu-"));
      const cache = `${cacheDir}/cache.db`;
      try {
        // Первое открытие сеет и мигрирует: это свойство любой строки,
        // мерим после.
        openRegistryBook(file)[Symbol.dispose]();
        const before = [await bytesOf(file), await bytesOf(cache)];
        for (const id of ["S1", "S5", "S9", "S16a", "E2", "E4", "E9"]) {
          const ran = await runOnStand(file, PRE_TOOL_USE.words, stand, {
            io: {
              ...hookIo(stdinOf(caseOf(cases, id), live)),
              openCacheDb: () => openCacheDb(cache),
            },
          });
          expect([ran.exit, ran.native, ran.records], id).toStrictEqual([
            0,
            [],
            [],
          ]);
        }
        expect([await bytesOf(file), await bytesOf(cache)]).toStrictEqual(
          before,
        );
      } finally {
        await rm(cacheDir, { recursive: true });
      }
    });
  });
});

it("методы корня двери и it в пробе не исполняются", async () => {
  const live = LIVE;
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
        PRE_TOOL_USE.words,
        makeFakeIo(hookIo(stdin)),
        { stdout: () => {}, stderr: (text) => void (stderr += text) },
        {
          nativeCall: () => {},
          note: () => {},
          executedBy: () => {},
          log: NO_INVOKE_LOG,
        },
      );
      expect([exit, stderr]).toStrictEqual([
        0,
        "mpu claude-hook pre-tool-use: без решения — правила строку не решают\n",
      ]);
    }
  });
  expect({ produced, recalled }).toStrictEqual({ produced: 0, recalled: 0 });
});

it("справка: однострока, фрагмент настроек — как в эталоне", async () => {
  const command = findCommand(PRE_TOOL_USE.words);
  assert(command !== undefined);
  expect(command.summary).toBe(
    "Какое решение правил mpu у вызова инструмента Claude Code?",
  );
  const fragment = command.help.slice(command.help.lastIndexOf("\n{") + 1);
  expect(JSON.parse(fragment)).toStrictEqual(
    JSON.parse(await readFile(testdata("settings-fragment.json"), "utf8")),
  );
});

it("S23: посев на пустом файле — путь хука allow", () =>
  withPolicyFile((file) => {
    assert(
      rulesOf(file).some((rule) =>
        rule.path === "claude-hook pre-tool-use" && rule.verdict === "allow"
      ),
    );
    return Promise.resolve();
  }));

it("сбой книги при решении пробы — правила недоступны, код 0", async () => {
  const { cases } = GOLDEN;
  const live = LIVE;
  await withStand((stand) =>
    withPolicyFile(async (file) => {
      const ran = await hook(
        file,
        stand,
        stdinOf(caseOf(cases, "S1"), live),
        () => writeFileSync(file, "не SQLite\n".repeat(4096)),
      );
      expect([ran.exit, ran.stdout]).toStrictEqual([0, ""]);
      assert(
        ran.stderr.startsWith(
          "mpu claude-hook pre-tool-use: без решения — правила недоступны: " +
            "правила подтверждения: ",
        ),
        ran.stderr,
      );
      expect(ran.stderr.split("\n").length, ran.stderr).toBe(2);
    })
  );
});

describe("--json: источник строки — как у ядра", () => {
  const live = LIVE;
  // `--json run: x` — программа из файла; одно `--json` — не строка без
  // слов (`isBareLine`), ядро ведёт её цепочкой к справке.
  const cases = [
    [["--json", "run:", "x.mpu"], "программа: содержимое не видно"],
    [["--json"], "правила строку не решают"],
  ] as const;
  for (const [words, reason] of cases) {
    it(
      words.join(" "),
      () =>
        withStand((stand) =>
          withPolicyFile(async (file) => {
            const ran = await hook(
              file,
              stand,
              JSON.stringify({
                ...live,
                tool_name: "mcp__mpu__mpu",
                tool_input: { words },
              }),
            );
            expect(ran.stderr).toStrictEqual(
              `mpu claude-hook pre-tool-use: без решения — ${reason}\n`,
            );
          })
        ),
    );
  }
});

it("строка хука в вызове — маршрут строки хука, а не обход цепочкой", async () => {
  const live = LIVE;
  const calls = [
    {
      tool_name: "Bash",
      tool_input: { command: "mpu claude-hook pre-tool-use" },
    },
    {
      tool_name: "mcp__mpu__mpu",
      tool_input: { words: [...PRE_TOOL_USE.words] },
    },
  ];
  await withStand((stand) =>
    withPolicyFile(async (file) => {
      for (const call of calls) {
        const ran = await hook(
          file,
          stand,
          JSON.stringify({ ...live, ...call }),
        );
        expect(
          { exit: ran.exit, stdout: ran.stdout, stderr: ran.stderr },
          call.tool_name,
        ).toStrictEqual({
          exit: 0,
          stdout: "",
          stderr:
            "mpu claude-hook pre-tool-use: без решения — решается при исполнении\n",
        });
      }
    })
  );
});
