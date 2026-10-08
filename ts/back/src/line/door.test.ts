/**
 * Дверь `ask` (`platform/ask-door.md`): строка с решением `ask` исполняется
 * только через `mpu ask`, строка `allow` — только без неё, `deny` — ни
 * одним адресом; списки справки каждого взгляда — по решениям на момент
 * строки. Исполнялась ли команда — по отметке журнала.
 */

import { readFile } from "node:fs/promises";
import { GRAMMAR } from "@mpu/language/messages";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { CommandIo } from "@mpu/command";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import {
  ALLOW,
  ASK,
  DENY,
  RuleBook,
  RulePath,
  type Verdict,
} from "@mpu/command/policy";
import { makeFakeIo } from "@mpu/command/testing";
import { lineEntry, policyTree, registryNodes } from "./mod.ts";
import { registrySeeds } from "./seeds.ts";
import {
  consentOf,
  openPolicyFile,
  type PolicyFile,
  withPolicyFile,
} from "./testconsent.ts";

/** Канал с человеком: stdin и stderr — терминалы. */
const HUMAN: Partial<CommandIo> = {
  stdinIsTerminal: () => true,
  stderrIsTerminal: () => true,
};

/** Читающая команда, исполнимая без сети и с отметкой журнала. */
const READING = ["xlsx", "alias", "ls", GRAMMAR.close, "json"];

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Пути команд, дошедших до исполнения. */
  readonly called: readonly string[];
}

/**
 * Ввода нет — как у кадра без `stdin`: строка без слов (`ask`) его
 * читает и получает пустое (`platform/program-input.md`).
 */
const NO_INPUT = () => Promise.resolve(new Uint8Array());

/**
 * Одна строка — один процесс: книга правил открывается заново.
 *
 * @param answers ответы человека по очереди; есть — канал с человеком
 */
async function run(
  file: string,
  argv: readonly string[],
  answers?: readonly string[],
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const io = makeFakeIo({
    readStdin: NO_INPUT,
    ...(answers === undefined ? {} : HUMAN),
  });
  const code = await lineEntry(consentOf(file, answers))(
    argv,
    io,
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Правило, записанное другим процессом (терминал или web). */
function ruleFrom(file: string, path: string, verdict: Verdict) {
  using book = RuleBook.open(file, []);
  book.set(RulePath.parse(path), verdict);
}

/** Снять посеянное правило: книга открывается с посевом, чтобы он не вернулся. */
function forgetFrom(file: string, path: string) {
  using book = RuleBook.open(file, registrySeeds());
  book.forget(RulePath.parse(path));
}

/** Селекторы раздела «Сообщения» справки объекта. */
function listed(help: string): string[] {
  const [, messages = ""] = help.split("Сообщения:\n");
  return messages
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.trim().split(/\s+/)[0]);
}

it("ask-строка без двери — адресный отказ, вопроса нет", () =>
  withPolicyFile(async (file) => {
    expect(
      await run(file, ["sql", "target:", "sl-1", "sql:", "select 1"], ["y"]),
    ).toStrictEqual({
      code: 2,
      stdout: "",
      stderr:
        "mpu sql target: sl-1 sql: select 1: требует подтверждения — " +
        'вызывай mpu ask sql target: sl-1 sql: "select 1"\n',
      called: [],
    });
  }));

it("mp-clone без двери — отказ живой формы (C12)", () =>
  withPolicyFile(async (file) => {
    expect(await run(file, ["mp-clone"], ["y"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr:
        "mpu mp-clone: требует подтверждения — вызывай mpu ask mp-clone\n",
      called: [],
    });
  }));

it("ask-строка через дверь — прежний вопрос каналу", () =>
  withPolicyFile(async (file) => {
    const line = ["ask", "sql", "target:", "sl-1", "sql:", "select 1"];
    expect(await run(file, line)).toStrictEqual({
      code: 1,
      stdout: "",
      stderr:
        "mpu sql target: sl-1 sql: select 1: нужно подтверждение, а спросить некого\n",
      called: [],
    });
    expect(await run(file, line, ["n"])).toStrictEqual({
      code: 1,
      stdout: "",
      stderr:
        "выполнить mpu sql target: sl-1 sql: select 1? [y/N] " +
        "mpu sql target: sl-1 sql: select 1: не подтверждено\n",
      called: [],
    });
  }));

it("через дверь «да» — исполнение строки без слова входа", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "xlsx alias ls", ASK);
    const yes = await run(file, ["ask", ...READING], ["y"]);
    expect(yes.stderr).toBe("выполнить mpu xlsx alias ls? [y/N] ");
    expect(yes.code).toBe(0);
    expect(yes.called).toStrictEqual(["xlsx alias ls"]);
    expect(JSON.parse(yes.stdout)).toStrictEqual({ aliases: [] });
  }));

it("allow-строка через дверь — исполнение, как без ask", () =>
  withPolicyFile(async (file) => {
    // Лишний `ask` безвреден: строка `allow` исполняется, как без него
    // (`platform/ask-door.md`, с порции 158).
    ruleFrom(file, "ozon-jobs show", ALLOW);
    for (const line of [
      [...READING],
      ["ozon-jobs", "show", "print", "local", "target:", "sl-2"],
    ]) {
      const plain = await run(file, line, ["y"]);
      const door = await run(file, ["ask", ...line], ["y"]);
      expect(door, line.join(" ")).toStrictEqual(plain);
      expect(door.stderr.includes("выполнить"), door.stderr).toBeFalsy();
    }
  }));

it("deny-строка: отказ по обоим адресам, в справке не видна", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "kiten close", DENY);
    for (const line of [
      ["kiten", "close", "id:", "1"],
      ["ask", "kiten", "close", "id:", "1"],
    ]) {
      expect(await run(file, line, ["y"]), line.join(" ")).toStrictEqual({
        code: 1,
        stdout: "",
        stderr: "mpu kiten close id: 1: запрещено правилом «kiten close»\n",
        called: [],
      });
    }
    for (const line of [
      ["kiten", "--help"],
      ["ask", "kiten", "--help"],
    ]) {
      const help = await run(file, line);
      expect(help.code, line.join(" ")).toBe(0);
      expect(listed(help.stdout).includes("close"), line.join(" ")).toBeFalsy();
    }
  }));

it("состав двери — по правилам на момент строки", () =>
  withPolicyFile(async (file) => {
    expect(
      listed((await run(file, ["ask", "kiten"])).stdout).includes("ls"),
    ).toBeFalsy();
    ruleFrom(file, "kiten ls", ASK);
    expect(await run(file, ["kiten", "ls"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr:
        "mpu kiten ls: требует подтверждения — вызывай mpu ask kiten ls\n",
      called: [],
    });
    expect((await run(file, ["ask", "kiten", "ls"], ["n"])).stderr).toBe(
      "выполнить mpu kiten ls? [y/N] mpu kiten ls: не подтверждено\n",
    );
    assert(listed((await run(file, ["ask", "kiten"])).stdout).includes("ls"));
    expect(
      listed((await run(file, ["kiten"])).stdout).includes("ls"),
    ).toBeFalsy();
    // `forget:` вернул бы наследуемое `ask`: посев снятый путь не сеет.
    ruleFrom(file, "kiten ls", ALLOW);
    expect(await run(file, ["ask", "kiten", "ls"])).toStrictEqual(
      await run(file, ["kiten", "ls"]),
    );
    expect(
      listed((await run(file, ["ask", "kiten"])).stdout).includes("ls"),
    ).toBeFalsy();
  }));

it("правило из другого процесса — до решения этой строки", () =>
  withPolicyFile(async (file) => {
    const err: string[] = [];
    const io = makeFakeIo({
      // Запись другого процесса — после открытия книги этой строкой.
      stdinIsTerminal: () => {
        ruleFrom(file, "kiten ls", ASK);
        return false;
      },
    });
    const code = await lineEntry(consentOf(file))(
      ["kiten", "ls"],
      io,
      {
        stdout: () => {},
        stderr: (text: string) => void err.push(text),
      },
      { nativeCall: () => {}, note: () => {} } as unknown as InvokeJournal,
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("вызывай mpu ask kiten ls");
  }));

it("справка двери: три адреса, живой список", () =>
  withPolicyFile(async (file) => {
    const door = await run(file, ["ask"]);
    assert(
      door.stdout.startsWith(
        "Использование: mpu ask <сообщение>\n\n" +
          "строки, которые спрашивают подтверждение человека\n\n",
      ),
      door.stdout,
    );
    for (const line of [
      ["ask", "--help"],
      ["ask", "help"],
    ]) {
      expect((await run(file, line)).stdout, line.join(" ")).toStrictEqual(
        door.stdout,
      );
    }
    const shown = listed(door.stdout);
    for (const name of ["sql", "kiten", "ozon-jobs"]) {
      assert(shown.includes(name), name);
    }
    for (const name of [
      "sql-ro",
      "ps",
      "log",
      "code",
      "policy",
      "allow:",
      "ask",
      "help",
      "version",
    ]) {
      expect(shown.includes(name), name).toBeFalsy();
    }
  }));

it("kiten в двух взглядах при посеве", () =>
  withPolicyFile(async (file) => {
    const door = await run(file, ["ask", "kiten"]);
    expect(listed(door.stdout)).toStrictEqual([
      "checklist",
      "close",
      "comment",
      "field",
      "move",
      "ready",
      "review",
      "time",
    ]);
    assert(door.stdout.startsWith("Использование: mpu ask kiten <сообщение>"));
    const plain = listed((await run(file, ["kiten"])).stdout);
    for (const name of ["close", "comment", "move", "ready", "review"]) {
      expect(plain.includes(name), name).toBeFalsy();
    }
    for (const name of ["ls", "card", "checklist", "time"]) {
      assert(plain.includes(name), name);
    }
  }));

it("корень обычного взгляда: вход ask есть, ask-команд нет", () =>
  withPolicyFile(async (file) => {
    const root = listed((await run(file, ["--help"])).stdout);
    for (const name of ["ask", "ask:", "policy", "help", "version", "sql-ro"]) {
      assert(root.includes(name), name);
    }
    for (const name of ["sql", "ozon-jobs"]) {
      expect(root.includes(name), name).toBeFalsy();
    }
  }));

describe("дверь не понимает сообщений корня", () => {
  // Шаги и проверка после них идут по одному файлу правил: ни отказ
  // шага, ни двойная дверь его не меняют. Проверка после шагов — в
  // afterAll: её падение красит набор, как прежде красило тест.
  let policy: PolicyFile;
  let file = "";
  let before: Uint8Array;
  beforeAll(async () => {
    policy = await openPolicyFile();
    file = policy.path;
    await run(file, ["policy"]);
    before = await readFile(file);
  });
  afterAll(async () => {
    try {
      const twice = await run(file, ["ask", "ask", "sql"]);
      expect(twice.code).toBe(2);
      assert(twice.stderr.startsWith("mpu ask: не понимает ask"), twice.stderr);
      expect(await readFile(file)).toStrictEqual(before);
    } finally {
      await policy.close();
    }
  });
  for (const [line, stderr] of [
    [["ask", "allow:", "kiten"], "mpu ask: не понимает allow:\n"],
    [["ask", "kitn"], "mpu ask: не понимает kitn; ближайшие: kiten\n"],
    [["ask", "policy"], "mpu ask: не понимает policy\n"],
  ] as const) {
    it(line.join(" "), async () => {
      expect(await run(file, line, ["y"])).toStrictEqual({
        code: 2,
        stdout: "",
        stderr,
        called: [],
      });
    });
  }
});

it("справка команды не зависит от адреса", () =>
  withPolicyFile(async (file) => {
    for (const [line, head] of [
      [["sql", "--help"], "Использование: mpu sql <сообщение>"],
      [["ask", "sql", "--help"], "Использование: mpu ask sql <сообщение>"],
    ] as const) {
      const help = await run(file, line, ["y"]);
      expect(help.code, line.join(" ")).toBe(0);
      expect(help.stderr, line.join(" ")).toBe("");
      assert(help.stdout.startsWith(head), help.stdout);
    }
  }));

it("группа с селектором впереди: строка — через подкоманду", () =>
  withPolicyFile(async (file) => {
    const line = ["ozon-jobs", "show", "target:", "sl-2"];
    expect(await run(file, line)).toStrictEqual({
      code: 2,
      stdout: "",
      stderr:
        "mpu ozon-jobs show target: sl-2: требует подтверждения — " +
        "вызывай mpu ask ozon-jobs show target: sl-2\n",
      called: [],
    });
    expect((await run(file, ["ask", ...line], ["n"])).stderr).toStrictEqual(
      "выполнить mpu ozon-jobs show target: sl-2? [y/N] " +
        "mpu ozon-jobs show target: sl-2: не подтверждено\n",
    );
  }));

it("группа с селектором впереди: правило группы — подкомандам без своего", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "ozon-jobs", ALLOW);
    forgetFrom(file, "ozon-jobs show");
    const local = await run(file, [
      "ozon-jobs",
      "show",
      "print",
      "local",
      "target:",
      "sl-2",
    ]);
    expect(local.code, local.stderr).toBe(0);
  }));

it("ask — не звено пути правил", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "ask", DENY);
    ruleFrom(file, "xlsx alias ls", ASK);
    const yes = await run(file, ["ask", ...READING], ["y"]);
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.called).toStrictEqual(["xlsx alias ls"]);
    expect(
      policyTree(file).filter((node) => node.path[0] === "ask"),
    ).toStrictEqual([]);
  }));

it("снимок дерева без входа ask", () => {
  const [root] = registryNodes();
  expect(root.messages.some((line) => line.selector === "ask")).toBeFalsy();
});

describe("голдены: справка двери и kiten в двух взглядах при посеве", () => {
  for (const [name, line] of [
    ["help-ask.txt", ["ask"]],
    ["help-ask-kiten.txt", ["ask", "kiten"]],
    ["help-kiten.txt", ["kiten"]],
  ] as const) {
    it(name, () =>
      withPolicyFile(async (file) => {
        const url = new URL(`testdata/ask-door/${name}`, import.meta.url);
        expect((await run(file, line)).stdout).toStrictEqual(
          await readFile(url, "utf8"),
        );
      }),
    );
  }
});

it("файл испорчен до справки: отказ, а не пустой список", () =>
  withPolicyFile(async (file) => {
    await run(file, ["policy"]);
    const out: string[] = [];
    const err: string[] = [];
    const io = makeFakeIo({
      readStdin: NO_INPUT,
      // Другой процесс портит файл между открытием книги и справкой.
      stdinIsTerminal: () => {
        const raw = new DatabaseSync(file);
        try {
          raw.exec("UPDATE rules SET verdict = 'maybe'");
        } finally {
          raw.close();
        }
        return false;
      },
    });
    const code = await lineEntry(consentOf(file))(
      ["ask"],
      io,
      {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      },
      { nativeCall: () => {}, note: () => {} } as unknown as InvokeJournal,
    );
    expect(code).toBe(2);
    expect(out).toStrictEqual([]);
    expect(err.join("")).toBe(
      'mpu ask: правила подтверждения: неизвестное решение "maybe"\n',
    );
  }));
