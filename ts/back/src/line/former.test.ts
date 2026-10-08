/**
 * Прежние формы строки (`platform/stage6-l1.md`, «Прежние формы и один
 * отказ»): строка с прежней формой не исполняет ничего, отказ один — код 2,
 * найденное слово в тексте, одна запись журнала; строки грамматики идут
 * прежним путём. Журнал — настоящий, поверх временного файла, той же
 * склейкой, что у процесса (`runJournaled`).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import type { RefusalData } from "@mpu/language/frames";
import { makeInvokeLog } from "@mpu/invokelog";
import { runJournaled } from "../process/mod.ts";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";
import { runOnStand, withStand } from "./testline.ts";

/** Совет отказа — после найденного слова; один на все прежние формы. */
const ADVICE =
  " — не команда mpu: одна строка — одна команда (путь → варианты → " +
  "ключи → end → формат); несколько команд — отдельными вызовами mpu " +
  "или сценарием mpu-flow; справка — mpu help\n";

/** Итог строки: код, вывод, отказы-объекты, исполнения, записи журнала. */
interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly refusals: readonly RefusalData[];
  readonly executed: number;
  readonly records: readonly string[];
}

/** Ввод из пайпа с текстом `text`. */
function piped(text: string): Partial<CommandIo> {
  return {
    stdinIsTerminal: () => false,
    readStdin: () => Promise.resolve(new TextEncoder().encode(text)),
  };
}

/** Строка `argv` под журналом, правила — `allow` на всё. */
async function run(
  argv: readonly string[],
  input: Partial<CommandIo> = {},
): Promise<Ran> {
  let ran: Ran | undefined;
  await withPolicyFile(async (file) => {
    allowEverything(file);
    ran = await journaled(file, argv, input);
  });
  if (ran === undefined) throw new Error("строка не прогнана");
  return ran;
}

/** Строка `argv` с файлом правил `file` под журналом во временном файле. */
async function journaled(
  file: string,
  argv: readonly string[],
  input: Partial<CommandIo>,
): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-former-"));
  try {
    const path = `${dir}/mpu.log`;
    const log = makeInvokeLog({
      env: { get: () => undefined },
      defaultFile: path,
      pid: 777,
      now: () => new Date(),
    });
    const out: string[] = [];
    const err: string[] = [];
    const refusals: RefusalData[] = [];
    let executed = 0;
    const entry = lineEntry({
      ...consentOf(file),
      refusal: (data) => void refusals.push(data),
      execute: (job) => {
        executed++;
        return job();
      },
    });
    const code = await runJournaled(
      argv,
      entry,
      makeFakeIo({ cwd: () => "/work", ...input }),
      log,
      {
        stdout: (text) => void out.push(text),
        stderr: (text) => void err.push(text),
      },
    );
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
        throw e;
      }
    }
    const records = text.split("\n").filter((one) => one.startsWith("### "));
    return {
      code,
      stdout: out.join(""),
      stderr: err.join(""),
      refusals,
      executed,
      records,
    };
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Сценарий 1: строка, найденное слово (как в тексте отказа), ввод. */
const FORMER: readonly {
  readonly argv: readonly string[];
  readonly word: string;
  readonly input?: Partial<CommandIo>;
}[] = [
  { argv: ["x", ":=", "5"], word: ":=" },
  { argv: ["kiten", "ls", ".", "kiten", "whoami"], word: "." },
  { argv: ["^привет^", "print"], word: "^привет^" },
  { argv: ["@x", "print"], word: "@x" },
  { argv: ["rem", "что-то"], word: "rem" },
  { argv: ["2", "plus:", "2"], word: "2" },
  { argv: ["kiten", "define:", "x"], word: "define:" },
  { argv: ["image", "sync", "dry"], word: "image" },
  { argv: ["run:", "a.mpu"], word: "run:" },
  { argv: [], word: "stdin", input: piped("kiten ls") },
  { argv: ["ask", "x", ":=", "5"], word: ":=" },
  { argv: ["ask"], word: "stdin", input: piped("kiten ls\n") },
  { argv: ["kiten", "ls", "each:", "do", ":c", "it", "done"], word: '"do :c"' },
  { argv: ["kiten", "forget:", "x"], word: "forget:" },
  { argv: ["kiten", "comment", "id:", "5", "--", "text:", "."], word: "." },
  { argv: ["kiten", "ls", "done"], word: "done" },
  { argv: ["kiten", "ls", "--md", ".", "kiten", "whoami"], word: "." },
  { argv: ["kiten", "card", "id:", "1", "--md", "done"], word: "done" },
  { argv: ["kiten", "ls", "--help", "^привет^"], word: "^привет^" },
  { argv: ["kiten", "card", "--id=5", "."], word: "." },
  { argv: ["kiten", "ls", "мир^"], word: "мир^" },
  { argv: ["^привет", "мир^", "print"], word: "^привет" },
];

describe("прежняя форма: отказ, код 2, ничего не исполнено, одна запись", () => {
  for (const { argv, word, input } of FORMER) {
    it(`mpu ${argv.join(" ")}`, async () => {
      const ran = await run(argv, input);
      const text = `mpu: ${word}${ADVICE}`;
      expect(ran.code, ran.stderr).toBe(2);
      expect(ran.stderr).toStrictEqual(text);
      expect(ran.stdout).toStrictEqual("");
      expect(ran.executed, "исполнение").toBe(0);
      expect(ran.refusals).toStrictEqual([
        {
          reason: "не команда mpu",
          hint: null,
          candidates: [],
          text: text.slice(0, -1),
        },
      ]);
      expect(ran.records.length, "записи журнала").toBe(1);
    });
  }
});

/**
 * Не прежняя форма: значение любого ключа как есть (`^_^`, `@ivan`,
 * `@req.json`), слово за `--`, группа значения, корневой `forget:`, `@x`
 * не первым словом — строка идёт прежним путём (отказа «не команда mpu»
 * нет; что значение доходит до команды — стенд ниже).
 */
const PLAIN: readonly (readonly string[])[] = [
  ["kiten", "comment", "id:", "5", "text:", ".", "help"],
  ["kiten", "comment", "id:", "5", "text:", "@all", "help"],
  ["kiten", "comment", "id:", "5", "text:", "rem", "help"],
  ["kiten", "card", "id:", "--", "@c", "help"],
  ["kiten", "card", "id:", "do", "it", ".", "end", "help"],
  ["forget:", "kiten"],
  ["log", "run:", "20260801-120000.000-1003"],
  ["kiten", "ls", "@x"],
  ["kiten", "card", "id:", "@c", "help"],
  ["kiten", "card", "--id", "@c", "help"],
  ["nosuch", "id:", "@c"],
  ["kiten", "comment", "id:", "1", "text:", "^_^", "help"],
  ["kiten", "comment", "id:", "1", "text:", "@ivan", "help"],
  ["telegram", "send", "chat:", "@username", "text:", "x", "help"],
  ["api", "get-ss-values", "id:", "ss1", "body:", "@req.json"],
  ["api", "get-ss-values", "id:", "ss1", "--body", "@req.json"],
  ["help"],
];

describe("строка грамматики — без отказа прежней формы", () => {
  for (const argv of PLAIN) {
    it(`mpu ${argv.join(" ")}`, async () => {
      const ran = await run(argv);
      expect(
        ran.refusals.map((one) => one.reason),
        ran.stderr,
      ).not.toContain("не команда mpu");
    });
  }
});

describe("голая строка без ввода — справка корня, как прежде", () => {
  const inputs: readonly [string, Partial<CommandIo>][] = [
    ["терминал", { stdinIsTerminal: () => true }],
    ["пустой ввод", piped("")],
    ["ввод без слов", piped(" \n")],
  ];
  for (const [name, input] of inputs) {
    it(name, async () => {
      const ran = await run([], input);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toContain("Использование: mpu <сообщение>");
    });
  }
});

describe("ключ-текст на стенде: текст уходит как есть", () => {
  const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
    [
      ["kiten", "comment", "id:", "11", "text:", "@ivan готово. Проверьте"],
      ["11 @ivan готово. Проверьте"],
    ],
    [["kiten", "comment", "id:", "11", "text:", "^_^"], ["11 ^_^"]],
    [["kiten", "comment", "id:", "11", "text:", "@ivan"], ["11 @ivan"]],
  ];
  for (const [line, posted] of cases) {
    it(line.join(" "), () =>
      withPolicyFile((file) =>
        withStand(async (stand) => {
          allowEverything(file);
          const before = stand.posted().length;
          const ran = await runOnStand(file, line, stand);
          expect(ran.exit, ran.stderr).toBe(0);
          expect(stand.posted().slice(before)).toStrictEqual(posted);
        }),
      ),
    );
  }
});
