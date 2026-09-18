/**
 * Правила подтверждения на строке `mpu-next` (`platform/policy.md`):
 * посев, решение перед исполнением, вопрос каналу, изменение правил
 * только человеком, чужая запись и нечитаемый файл. Исполнялась ли
 * команда — по отметке журнала, а не по тексту отказа.
 */

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { DENY, RuleBook, RulePath } from "../policy/mod.ts";
import { commands } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { nextEntry } from "./mod.ts";
import { ruleMethods } from "./rules.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";

/** Канал с человеком: stdin и stderr — терминалы. */
const HUMAN: Partial<CommandIo> = {
  stdinIsTerminal: () => true,
  stderrIsTerminal: () => true,
};

/** Читающая команда, исполнимая без сети и с отметкой журнала. */
const READING = ["xlsx", "alias", "ls", "--json"];

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
  const code = await nextEntry(consentOf(file, answers))(argv, io, {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  }, journal);
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

async function rules(file: string) {
  const listed = await run(file, ["policy"]);
  assertEquals(listed.code, 0, listed.stderr);
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
  assertEquals(changed.code, 0, changed.stderr);
  return changed;
}

Deno.test("посев первого старта и ничего заново на втором", () =>
  withPolicyFile(async (file) => {
    const first = await rules(file);
    for (
      const [path, verdict] of [
        ["kiten card", "allow"],
        ["kiten comment", "ask"],
        ["mcp", "ask"],
        ["ozon-jobs", "ask"],
        ["policy", "allow"],
        ["version", "allow"],
      ]
    ) {
      assertEquals(verdictOf(first, path), verdict, path);
    }
    assertEquals(verdictOf(first, "*"), undefined, "корневое правило");
    assertEquals(
      first.map((rule) => rule.path),
      first.map((r) => r.path).sort(),
    );
    assertEquals(await rules(file), first);
  }));

Deno.test("посев: у каждой команды правило по ro/rw", () =>
  withPolicyFile(async (file) => {
    const listed = await rules(file);
    for (const command of commands) {
      assertEquals(
        verdictOf(listed, command.path.join(" ")),
        command.policy === "ro" ? "allow" : "ask",
        command.path.join(" "),
      );
    }
  }));

Deno.test("забытое правило не возвращается посевом", () =>
  withPolicyFile(async (file) => {
    const forgot = await confirmed(file, "forget:", "kiten card");
    assertEquals(JSON.parse(forgot.stdout), {
      path: "kiten card",
      verdict: null,
    });
    assertEquals(verdictOf(await rules(file), "kiten card"), undefined);
    const card = await run(file, ["kiten", "card", "1"]);
    assertEquals(card, {
      code: 1,
      stdout: "",
      stderr: "mpu kiten card 1: нужно подтверждение, а спросить некого\n",
      called: [],
    });
  }));

Deno.test("deny на корне: отказ строке, policy и справка работают", () =>
  withPolicyFile(async (file) => {
    // Посевные `kiten ls allow` и `kiten card allow` длиннее корня —
    // снимаются, чтобы строки решал корень.
    await confirmed(file, "forget:", "kiten ls");
    await confirmed(file, "forget:", "kiten card");
    await confirmed(file, "deny:", "*");
    assertEquals(await run(file, ["kiten", "ls"]), {
      code: 1,
      stdout: "",
      stderr: "mpu kiten ls: запрещено правилом «*»\n",
      called: [],
    });
    assertEquals(verdictOf(await rules(file), "*"), "deny");
    const help = await run(file, ["kiten", "card", "1", "--help"]);
    assertEquals(help.code, 0);
    assertEquals(help.stderr, "");
    assertEquals(help.called, []);
  }));

Deno.test("ask: без человека, ответ нет, ответ YES", () =>
  withPolicyFile(async (file) => {
    await confirmed(file, "ask:", READING.slice(0, 3).join(" "));
    assertEquals(await run(file, READING), {
      code: 1,
      stdout: "",
      stderr: "mpu xlsx alias ls: нужно подтверждение, а спросить некого\n",
      called: [],
    });
    assertEquals(await run(file, READING, ["n"]), {
      code: 1,
      stdout: "",
      stderr: "выполнить mpu xlsx alias ls? [y/N] " +
        "mpu xlsx alias ls: не подтверждено\n",
      called: [],
    });
    const yes = await run(file, READING, ["YES"]);
    assertEquals(yes.code, 0, yes.stderr);
    assertEquals(yes.stderr, "выполнить mpu xlsx alias ls? [y/N] ");
    assertEquals(yes.called, ["xlsx alias ls"]);
  }));

Deno.test("изменить правила без человека нельзя, файл не меняется", () =>
  withPolicyFile(async (file) => {
    const before = await rules(file);
    const bytes = await Deno.readFile(file);
    for (const message of ["allow:", "ask:", "deny:", "forget:"]) {
      assertEquals(await run(file, [message, "kiten ls"]), {
        code: 1,
        stdout: "",
        stderr: "изменить правила может только человек\n",
        called: [],
      }, message);
    }
    assertEquals(await Deno.readFile(file), bytes);
    assertEquals(await rules(file), before);
  }));

Deno.test("изменение правила: вопрос, ответ нет — файл не меняется", () =>
  withPolicyFile(async (file) => {
    const before = await rules(file);
    assertEquals(await run(file, ["deny:", "kiten  ls *"], ["n"]), {
      code: 1,
      stdout: "",
      stderr: "изменить правило: kiten ls → deny? [y/N] " +
        "mpu deny: kiten  ls *: не подтверждено\n",
      called: [],
    });
    assertEquals(await rules(file), before);
    const denied = await run(file, ["deny:", "kiten  ls *"], ["y"]);
    assertEquals(JSON.parse(denied.stdout), {
      path: "kiten ls",
      verdict: "deny",
    });
    assertEquals(verdictOf(await rules(file), "kiten ls"), "deny");
  }));

Deno.test("правило, записанное другим процессом, решает следующую строку", () =>
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
    const code = await nextEntry(consentOf(file))(
      ["kiten", "ls"],
      io,
      output,
      journal,
    );
    assertEquals(code, 1);
    assertEquals(err.join(""), "mpu kiten ls: запрещено правилом «kiten ls»\n");
    assertEquals(called, []);
  }));

Deno.test("файл правил — мусор: отказ до разбора, даже справке", () =>
  withPolicyFile(async (file) => {
    await Deno.writeTextFile(file, "не SQLite ".repeat(200));
    for (
      const argv of [["kiten", "ls"], ["policy"], ["kiten", "card", "--help"], [
        "нет-такого",
      ]]
    ) {
      const broken = await run(file, argv);
      assertEquals(broken.code, 1, argv.join(" "));
      assertEquals(broken.stdout, "", argv.join(" "));
      assertEquals(broken.called, [], argv.join(" "));
      assertEquals(
        broken.stderr.startsWith("правила подтверждения: "),
        true,
        broken.stderr,
      );
    }
  }));

Deno.test("файл испорчен после открытия: отказ правил, не исполнение", async (t) => {
  for (const argv of [READING, ["policy"]]) {
    await t.step(argv.join(" "), () =>
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
        const code = await nextEntry(consentOf(file))(argv, io, {
          stdout: () => {},
          stderr: (text: string) => void err.push(text),
        }, journal);
        assertEquals(code, 1);
        assertEquals(
          err.join(""),
          'правила подтверждения: неизвестное решение "maybe"\n',
        );
        assertEquals(called, []);
      }));
  }
});

Deno.test("после policy сообщений нет", () =>
  withPolicyFile(async (file) => {
    assertEquals(await run(file, ["policy", "selectors"]), {
      code: 2,
      stdout: "",
      stderr: "mpu policy: цепочка окончена, selectors отправить некому\n",
      called: [],
    });
  }));

Deno.test("allow: на группе с селектором называет пишущие подкоманды", () =>
  withPolicyFile(async (file) => {
    const asked = await run(file, ["allow:", "ozon-jobs"], ["n"]);
    assertEquals(
      asked.stderr.split("\n")[0].split("? [y/N] ")[0],
      // Обе подкоманды `ozon-jobs` в реестре — `rw` (исполнение на сервере).
      "изменить правило: ozon-jobs → allow (группа: подкоманды с записью — show, prune)",
    );
    const plain = await run(file, ["deny:", "ozon-jobs"], ["n"]);
    assertEquals(
      plain.stderr.split("? [y/N] ")[0],
      "изменить правило: ozon-jobs → deny",
    );
  }));

Deno.test("путь правила пуст — отказ объекта, код 2", () =>
  withPolicyFile(async (file) => {
    assertEquals(await run(file, ["allow:", "  "], ["y"]), {
      code: 2,
      stdout: "",
      stderr: "mpu: путь правила пуст\n",
      called: [],
    });
  }));

Deno.test("значение ключа — путь правила, а не справка", () =>
  withPolicyFile(async (file) => {
    const changed = await run(file, ["allow:", "--", "--help"], ["y"]);
    assertEquals(JSON.parse(changed.stdout), {
      path: "--help",
      verdict: "allow",
    });
  }));

Deno.test("справка сообщения правил ничего не пишет", () =>
  withPolicyFile(async (file) => {
    const before = await rules(file);
    const help = await run(file, ["allow:", "kiten", "--help"], ["y"]);
    assertEquals(help.code, 0);
    assertEquals(help.stderr, "");
    assertEquals(await rules(file), before);
  }));

Deno.test("имена сообщений корня не совпадают с командами реестра", () => {
  const own = ruleMethods().map((method) => method.selector).sort();
  assertEquals(own, ["allow:", "ask:", "deny:", "forget:", "policy"]);
  const top = new Set(commands.map((command) => command.path[0]));
  for (const name of own) {
    assertEquals(top.has(name), false, name);
    assertEquals(top.has(name.replace(/:$/, "")), false, name);
  }
});
