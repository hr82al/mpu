/**
 * Правила подтверждения на строке (`platform/policy.md`):
 * посев, решение перед исполнением, вопрос каналу, изменение правил
 * только человеком, чужая запись и нечитаемый файл. Исполнялась ли
 * команда — по отметке журнала, а не по тексту отказа.
 */

import { readFile, writeFile } from "node:fs/promises";
import { GRAMMAR } from "@mpu/language/messages";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { CommandIo } from "@mpu/command";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { ASK, DENY, RuleBook, RulePath } from "@mpu/command/policy";
import { commands } from "../registry/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
import { lineEntry } from "./mod.ts";
import { ruleMethods } from "./rules.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";

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
  const io = makeFakeIo(answers === undefined ? {} : HUMAN);
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

async function rules(file: string) {
  const listed = await run(file, ["policy"]);
  expect(listed.code, listed.stderr).toBe(0);
  return JSON.parse(listed.stdout) as { path: string; verdict: string }[];
}

function verdictOf(
  listed: readonly { path: string; verdict: string }[],
  path: string,
) {
  return listed.find((rule) => rule.path === path)?.verdict;
}

/** Изменение правила, подтверждённое человеком. */
async function confirmed(file: string, message: string, path: string) {
  const changed = await run(file, [message, path], ["y"]);
  expect(changed.code, changed.stderr).toBe(0);
  return changed;
}

it("посев первого старта и ничего заново на втором", () =>
  withPolicyFile(async (file) => {
    const first = await rules(file);
    for (const [path, verdict] of [
      ["kiten card", "allow"],
      ["kiten comment", "ask"],
      ["ozon-jobs", "ask"],
      ["policy", "allow"],
      ["version", "allow"],
    ]) {
      expect(verdictOf(first, path), path).toStrictEqual(verdict);
    }
    expect(verdictOf(first, "*"), "корневое правило").toStrictEqual(undefined);
    expect(first.map((rule) => rule.path)).toStrictEqual(
      first.map((r) => r.path).sort(),
    );
    expect(await rules(file)).toStrictEqual(first);
  }));

/**
 * Посев не по признаку (`platform/policy.md`, «Посев»); `task rule`,
 * `task owner-answer` и `task role` пишет только человек — правила у пути
 * нет вовсе.
 */
const OWN_SEEDS: Readonly<Record<string, string | undefined>> = {
  "image export": "allow",
  "claude-hook permission-request": "allow",
  "claude-hook stop": "allow",
  "claude-hook notification": "allow",
  "claude-hook elicitation": "allow",
  "task post": "allow",
  "task report": "allow",
  "task question": "allow",
  "task answer": "allow",
  "task decision": "allow",
  "task owner": "allow",
  "task history": "allow",
  "task busy": "allow",
  "task idle": "allow",
  "task stop": "allow",
  "task rule": undefined,
  "task owner-answer": undefined,
  "task role": undefined,
};

it("посев: у каждой команды правило по ro/rw, кроме своего посева", () =>
  withPolicyFile(async (file) => {
    const listed = await rules(file);
    for (const command of commands) {
      const path = command.path.join(" ");
      expect(verdictOf(listed, path), path).toStrictEqual(
        path in OWN_SEEDS
          ? OWN_SEEDS[path]
          : command.policy === "ro"
            ? "allow"
            : "ask",
      );
    }
  }));

it("забытое правило не возвращается посевом", () =>
  withPolicyFile(async (file) => {
    const forgot = await confirmed(file, "forget:", "kiten card");
    expect(JSON.parse(forgot.stdout)).toStrictEqual({
      path: "kiten card",
      verdict: null,
    });
    expect(verdictOf(await rules(file), "kiten card")).toStrictEqual(undefined);
    const card = await run(file, ["ask", "kiten", "card", "id:", "1"]);
    expect(card).toStrictEqual({
      code: 1,
      stdout: "",
      stderr: "mpu kiten card id: 1: нужно подтверждение, а спросить некого\n",
      called: [],
    });
  }));

it("deny на корне: отказ строке, policy и справка работают", () =>
  withPolicyFile(async (file) => {
    // Посевные `kiten ls allow` и `kiten card allow` длиннее корня —
    // снимаются, чтобы строки решал корень.
    await confirmed(file, "forget:", "kiten ls");
    await confirmed(file, "forget:", "kiten card");
    await confirmed(file, "deny:", "*");
    expect(await run(file, ["kiten", "ls"])).toStrictEqual({
      code: 1,
      stdout: "",
      stderr: "mpu kiten ls: запрещено правилом «*»\n",
      called: [],
    });
    expect(verdictOf(await rules(file), "*")).toBe("deny");
    const help = await run(file, ["kiten", "card", "help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.called).toStrictEqual([]);
  }));

it("ask через дверь: без человека, ответ нет, ответ YES", () =>
  withPolicyFile(async (file) => {
    await confirmed(file, "ask:", READING.slice(0, 3).join(" "));
    const line = ["ask", ...READING];
    expect(await run(file, line)).toStrictEqual({
      code: 1,
      stdout: "",
      stderr: "mpu xlsx alias ls: нужно подтверждение, а спросить некого\n",
      called: [],
    });
    expect(await run(file, line, ["n"])).toStrictEqual({
      code: 1,
      stdout: "",
      stderr:
        "выполнить mpu xlsx alias ls? [y/N] " +
        "mpu xlsx alias ls: не подтверждено\n",
      called: [],
    });
    const yes = await run(file, line, ["YES"]);
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stderr).toBe("выполнить mpu xlsx alias ls? [y/N] ");
    expect(yes.called).toStrictEqual(["xlsx alias ls"]);
  }));

it("изменить правила без человека нельзя, файл не меняется", () =>
  withPolicyFile(async (file) => {
    const before = await rules(file);
    const bytes = await readFile(file);
    for (const message of ["allow:", "ask:", "deny:", "forget:"]) {
      expect(await run(file, [message, "kiten ls"]), message).toStrictEqual({
        code: 1,
        stdout: "",
        stderr: "изменить правила может только человек\n",
        called: [],
      });
    }
    expect(await readFile(file)).toStrictEqual(bytes);
    expect(await rules(file)).toStrictEqual(before);
  }));

it("изменение правила: вопрос, ответ нет — файл не меняется", () =>
  withPolicyFile(async (file) => {
    const before = await rules(file);
    expect(await run(file, ["deny:", "kiten  ls *"], ["n"])).toStrictEqual({
      code: 1,
      stdout: "",
      stderr:
        "изменить правило: kiten ls → deny? [y/N] " +
        "mpu deny: kiten  ls *: не подтверждено\n",
      called: [],
    });
    expect(await rules(file)).toStrictEqual(before);
    const denied = await run(file, ["deny:", "kiten  ls *"], ["y"]);
    expect(JSON.parse(denied.stdout)).toStrictEqual({
      path: "kiten ls",
      verdict: "deny",
    });
    expect(verdictOf(await rules(file), "kiten ls")).toBe("deny");
  }));

it("правило, записанное другим процессом, решает следующую строку", () =>
  withPolicyFile(async (file) => {
    // A — точка входа в работе: книгу открыл до записи B.
    const called: string[] = [];
    const journal = {
      nativeCall: (command: { readonly path: readonly string[] }) =>
        void called.push(command.path.join(" ")),
      note: () => {},
    } as unknown as InvokeJournal;
    const err: string[] = [];
    const output = {
      stdout: () => {},
      stderr: (text: string) => void err.push(text),
    };
    const io = makeFakeIo({
      // Запись B — между открытием книги A и её решением: первое, что
      // строка делает после открытия, — разбор, а исполнению
      // предшествует обращение к окружению.
      stdinIsTerminal: () => {
        using b = RuleBook.open(file, []);
        b.set(RulePath.parse("kiten ls"), DENY);
        return false;
      },
    });
    const code = await lineEntry(consentOf(file))(
      ["kiten", "ls"],
      io,
      output,
      journal,
    );
    expect(code).toBe(1);
    expect(err.join("")).toBe("mpu kiten ls: запрещено правилом «kiten ls»\n");
    expect(called).toStrictEqual([]);
  }));

it("файл правил — мусор: отказ до разбора, даже справке", () =>
  withPolicyFile(async (file) => {
    await writeFile(file, "не SQLite ".repeat(200));
    for (const argv of [
      ["kiten", "ls"],
      ["policy"],
      ["kiten", "card", "--help"],
      ["нет-такого"],
    ]) {
      const broken = await run(file, argv);
      expect(broken.code, argv.join(" ")).toBe(1);
      expect(broken.stdout, argv.join(" ")).toBe("");
      expect(broken.called, argv.join(" ")).toStrictEqual([]);
      expect(
        broken.stderr.startsWith("правила подтверждения: "),
        broken.stderr,
      ).toBe(true);
    }
  }));

describe("файл испорчен после открытия: отказ правил, не исполнение", () => {
  for (const argv of [READING, ["policy"]]) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        await rules(file);
        const err: string[] = [];
        const called: string[] = [];
        const journal = {
          nativeCall: (command: { readonly path: readonly string[] }) =>
            void called.push(command.path.join(" ")),
          note: () => {},
        } as unknown as InvokeJournal;
        const io = makeFakeIo({
          // Другой процесс портит файл между открытием книги и решением.
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
          argv,
          io,
          {
            stdout: () => {},
            stderr: (text: string) => void err.push(text),
          },
          journal,
        );
        expect(code).toBe(1);
        expect(err.join("")).toBe(
          'правила подтверждения: неизвестное решение "maybe"\n',
        );
        expect(called).toStrictEqual([]);
      }),
    );
  }
});

it("после policy сообщений нет", () =>
  withPolicyFile(async (file) => {
    expect(await run(file, ["policy", "selectors"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: "mpu policy: цепочка окончена, selectors отправить некому\n",
      called: [],
    });
  }));

it("allow: на группе с селектором называет пишущие подкоманды", () =>
  withPolicyFile(async (file) => {
    const asked = await run(file, ["allow:", "ozon-jobs"], ["n"]);
    expect(asked.stderr.split("\n")[0].split("? [y/N] ")[0]).toBe(
      // Обе подкоманды `ozon-jobs` в реестре — `rw` (исполнение на сервере).
      "изменить правило: ozon-jobs → allow (группа: подкоманды с записью — show, prune)",
    );
    const plain = await run(file, ["deny:", "ozon-jobs"], ["n"]);
    expect(plain.stderr.split("? [y/N] ")[0]).toBe(
      "изменить правило: ozon-jobs → deny",
    );
  }));

it("путь правила пуст — отказ объекта, код 2", () =>
  withPolicyFile(async (file) => {
    expect(await run(file, ["allow:", "  "], ["y"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: "mpu: путь правила пуст\n",
      called: [],
    });
  }));

it("значение ключа — путь правила, а не справка", () =>
  withPolicyFile(async (file) => {
    const changed = await run(file, ["allow:", "--", "--help"], ["y"]);
    expect(JSON.parse(changed.stdout)).toStrictEqual({
      path: "--help",
      verdict: "allow",
    });
  }));

it("справка сообщения правил ничего не пишет", () =>
  withPolicyFile(async (file) => {
    const before = await rules(file);
    // `--help` за значением — справка результата сообщения, а не его
    // исполнение (`platform/line-grammar.md` [D.8]).
    const help = await run(file, ["allow:", "kiten", "--help"], ["y"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(await rules(file)).toStrictEqual(before);
  }));

it("имена сообщений корня не совпадают с командами реестра", () => {
  const own = ruleMethods()
    .map((method) => method.selector)
    .sort();
  expect(own).toStrictEqual(["allow:", "ask:", "deny:", "forget:", "policy"]);
  const top = new Set(commands.map((command) => command.path[0]));
  for (const name of [...own, "ask"]) {
    expect(top.has(name), name).toBe(false);
    expect(top.has(name.replace(/:$/, "")), name).toBe(false);
  }
});

it("книга прежней версии: claude-hook notification ask → allow при открытии строкой", () =>
  withPolicyFile(async (file) => {
    {
      using _old = RuleBook.open(file, []);
      _old.set(RulePath.parse("claude-hook notification"), ASK);
    }
    const listed = await run(file, ["version"]);
    expect(listed.code, listed.stderr).toBe(0);
    using book = RuleBook.open(file, []);
    const hook = book
      .list()
      .find((rule) => rule.path === "claude-hook notification");
    expect(hook?.verdict).toBe("allow");
  }));
