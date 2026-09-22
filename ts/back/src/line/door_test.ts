/**
 * Дверь `ask` (`platform/ask-door.md`): строка с решением `ask` исполняется
 * только через `mpu ask`, строка `allow` — только без неё, `deny` — ни
 * одним адресом; списки справки каждого взгляда — по решениям на момент
 * строки. Исполнялась ли команда — по отметке журнала.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import {
  ALLOW,
  ASK,
  DENY,
  RuleBook,
  RulePath,
  type Verdict,
} from "../policy/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry, policyTree, registryNodes } from "./mod.ts";
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
  const code = await lineEntry(consentOf(file, answers))(argv, io, {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  }, journal);
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Правило, записанное другим процессом (терминал или web). */
function ruleFrom(file: string, path: string, verdict: Verdict) {
  using book = RuleBook.open(file, []);
  book.set(RulePath.parse(path), verdict);
}

/** Селекторы раздела «Сообщения» справки объекта. */
function listed(help: string): string[] {
  const [, messages = ""] = help.split("Сообщения:\n");
  return messages.split("\n")
    .filter((line) => line !== "")
    .map((line) => line.trim().split(/\s+/)[0]);
}

Deno.test("ask-строка без двери — адресный отказ, вопроса нет", () =>
  withPolicyFile(async (file) => {
    assertEquals(
      await run(file, ["sql", "target:", "sl-1", "sql:", "select 1"], ["y"]),
      {
        code: 2,
        stdout: "",
        stderr: "mpu sql target: sl-1 sql: select 1: требует подтверждения — " +
          "вызывай mpu ask sql target: sl-1 sql: select 1\n",
        called: [],
      },
    );
  }));

Deno.test("ask-строка через дверь — прежний вопрос каналу", () =>
  withPolicyFile(async (file) => {
    const line = ["ask", "sql", "target:", "sl-1", "sql:", "select 1"];
    assertEquals(await run(file, line), {
      code: 1,
      stdout: "",
      stderr:
        "mpu sql target: sl-1 sql: select 1: нужно подтверждение, а спросить некого\n",
      called: [],
    });
    assertEquals(await run(file, line, ["n"]), {
      code: 1,
      stdout: "",
      stderr: "выполнить mpu sql target: sl-1 sql: select 1? [y/N] " +
        "mpu sql target: sl-1 sql: select 1: не подтверждено\n",
      called: [],
    });
  }));

Deno.test("через дверь «да» — исполнение строки без слова входа", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "xlsx alias ls", ASK);
    const yes = await run(file, ["ask", ...READING], ["y"]);
    assertEquals(yes.stderr, "выполнить mpu xlsx alias ls? [y/N] ");
    assertEquals(yes.code, 0);
    assertEquals(yes.called, ["xlsx alias ls"]);
    assertEquals(
      JSON.parse(yes.stdout),
      JSON.parse(
        (await run(file, ["--json", "ask", ...READING.slice(0, 3)], ["y"]))
          .stdout,
      ),
    );
  }));

Deno.test("allow-строка через дверь — исполнение, как без ask", () =>
  withPolicyFile(async (file) => {
    // Лишний `ask` безвреден: строка `allow` исполняется, как без него
    // (`platform/ask-door.md`, с порции 158).
    ruleFrom(file, "ozon-jobs show", ALLOW);
    for (
      const line of [
        [...READING],
        ["ozon-jobs", "show"],
      ]
    ) {
      const plain = await run(file, line, ["y"]);
      const door = await run(file, ["ask", ...line], ["y"]);
      assertEquals(door, plain, line.join(" "));
      assertFalse(door.stderr.includes("выполнить"), door.stderr);
    }
  }));

Deno.test("deny-строка: отказ по обоим адресам, в справке не видна", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "kiten close", DENY);
    for (
      const line of [["kiten", "close", "1"], ["ask", "kiten", "close", "1"]]
    ) {
      assertEquals(await run(file, line, ["y"]), {
        code: 1,
        stdout: "",
        stderr: "mpu kiten close 1: запрещено правилом «kiten close»\n",
        called: [],
      }, line.join(" "));
    }
    for (const line of [["kiten", "--help"], ["ask", "kiten", "--help"]]) {
      const help = await run(file, line);
      assertEquals(help.code, 0, line.join(" "));
      assertFalse(listed(help.stdout).includes("close"), line.join(" "));
    }
  }));

Deno.test("состав двери — по правилам на момент строки", () =>
  withPolicyFile(async (file) => {
    assertFalse(
      listed((await run(file, ["ask", "kiten"])).stdout).includes("ls"),
    );
    ruleFrom(file, "kiten ls", ASK);
    assertEquals(await run(file, ["kiten", "ls"]), {
      code: 2,
      stdout: "",
      stderr:
        "mpu kiten ls: требует подтверждения — вызывай mpu ask kiten ls\n",
      called: [],
    });
    assertEquals(
      (await run(file, ["ask", "kiten", "ls"], ["n"])).stderr,
      "выполнить mpu kiten ls? [y/N] mpu kiten ls: не подтверждено\n",
    );
    assert(listed((await run(file, ["ask", "kiten"])).stdout).includes("ls"));
    assertFalse(listed((await run(file, ["kiten"])).stdout).includes("ls"));
    // `forget:` вернул бы наследуемое `ask`: посев снятый путь не сеет.
    ruleFrom(file, "kiten ls", ALLOW);
    assertEquals(
      await run(file, ["ask", "kiten", "ls"]),
      await run(file, ["kiten", "ls"]),
    );
    assertFalse(
      listed((await run(file, ["ask", "kiten"])).stdout).includes("ls"),
    );
  }));

Deno.test("правило из другого процесса — до решения этой строки", () =>
  withPolicyFile(async (file) => {
    const err: string[] = [];
    const io = makeFakeIo({
      // Запись другого процесса — после открытия книги этой строкой.
      stdinIsTerminal: () => {
        ruleFrom(file, "kiten ls", ASK);
        return false;
      },
    });
    const code = await lineEntry(consentOf(file))(["kiten", "ls"], io, {
      stdout: () => {},
      stderr: (text: string) => void err.push(text),
    }, { nativeCall: () => {}, note: () => {} } as unknown as InvokeJournal);
    assertEquals(code, 2);
    assertStringIncludes(err.join(""), "вызывай mpu ask kiten ls");
  }));

Deno.test("справка двери: три адреса, живой список", () =>
  withPolicyFile(async (file) => {
    const door = await run(file, ["ask"]);
    assert(
      door.stdout.startsWith(
        "Использование: mpu ask <сообщение>\n\n" +
          "строки, которые спрашивают подтверждение человека\n\n",
      ),
      door.stdout,
    );
    for (const line of [["ask", "--help"], ["ask", "help"]]) {
      assertEquals((await run(file, line)).stdout, door.stdout, line.join(" "));
    }
    const shown = listed(door.stdout);
    for (const name of ["sql", "kiten", "ozon-jobs"]) {
      assert(shown.includes(name), name);
    }
    for (
      const name of [
        "sql-ro",
        "ps",
        "log",
        "code",
        "policy",
        "allow:",
        "ask",
        "help",
        "version",
      ]
    ) {
      assertFalse(shown.includes(name), name);
    }
  }));

Deno.test("kiten в двух взглядах при посеве", () =>
  withPolicyFile(async (file) => {
    const door = await run(file, ["ask", "kiten"]);
    assertEquals(listed(door.stdout), [
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
      assertFalse(plain.includes(name), name);
    }
    for (const name of ["ls", "card", "checklist", "time"]) {
      assert(plain.includes(name), name);
    }
  }));

Deno.test("корень обычного взгляда: вход ask есть, ask-команд нет", () =>
  withPolicyFile(async (file) => {
    const root = listed((await run(file, ["--help"])).stdout);
    for (const name of ["ask", "ask:", "policy", "help", "version", "sql-ro"]) {
      assert(root.includes(name), name);
    }
    for (const name of ["sql", "ozon-jobs"]) {
      assertFalse(root.includes(name), name);
    }
  }));

Deno.test("дверь не понимает сообщений корня", (t) =>
  withPolicyFile(async (file) => {
    await run(file, ["policy"]);
    const before = await Deno.readFile(file);
    for (
      const [line, stderr] of [
        [["ask", "allow:", "kiten"], "mpu ask: не понимает allow:\n"],
        [["ask", "kitn"], "mpu ask: не понимает kitn; ближайшие: kiten\n"],
        [["ask", "policy"], "mpu ask: не понимает policy\n"],
      ] as const
    ) {
      await t.step(line.join(" "), async () => {
        assertEquals(await run(file, line, ["y"]), {
          code: 2,
          stdout: "",
          stderr,
          called: [],
        });
      });
    }
    const twice = await run(file, ["ask", "ask", "sql"]);
    assertEquals(twice.code, 2);
    assert(twice.stderr.startsWith("mpu ask: не понимает ask"), twice.stderr);
    assertEquals(await Deno.readFile(file), before);
  }));

Deno.test("справка команды не зависит от адреса", () =>
  withPolicyFile(async (file) => {
    for (
      const [line, head] of [
        [["sql", "--help"], "Использование: mpu sql <сообщение>"],
        [["ask", "sql", "--help"], "Использование: mpu ask sql <сообщение>"],
      ] as const
    ) {
      const help = await run(file, line, ["y"]);
      assertEquals(help.code, 0, line.join(" "));
      assertEquals(help.stderr, "", line.join(" "));
      assert(help.stdout.startsWith(head), help.stdout);
    }
  }));

Deno.test("группа с селектором впереди: решение группы, путь без ask", () =>
  withPolicyFile(async (file) => {
    const line = ["ozon-jobs", "sl-2", "show"];
    assertEquals(await run(file, line), {
      code: 2,
      stdout: "",
      stderr: "mpu ozon-jobs sl-2 show: требует подтверждения — " +
        "вызывай mpu ask ozon-jobs sl-2 show\n",
      called: [],
    });
    assertEquals(
      (await run(file, ["ask", ...line], ["n"])).stderr,
      "выполнить mpu ozon-jobs sl-2 show? [y/N] " +
        "mpu ozon-jobs sl-2 show: не подтверждено\n",
    );
  }));

Deno.test("ask — не звено пути правил", () =>
  withPolicyFile(async (file) => {
    ruleFrom(file, "ask", DENY);
    ruleFrom(file, "xlsx alias ls", ASK);
    const yes = await run(file, ["ask", ...READING], ["y"]);
    assertEquals(yes.code, 0, yes.stderr);
    assertEquals(yes.called, ["xlsx alias ls"]);
    assertEquals(
      policyTree(file).filter((node) => node.path[0] === "ask"),
      [],
    );
  }));

Deno.test("снимок дерева без входа ask", () => {
  const [root] = registryNodes();
  assertFalse(root.selectors.includes("ask"));
});

Deno.test("голдены: справка двери и kiten в двух взглядах при посеве", (t) =>
  withPolicyFile(async (file) => {
    for (
      const [name, line] of [
        ["help-ask.txt", ["ask"]],
        ["help-ask-kiten.txt", ["ask", "kiten"]],
        ["help-kiten.txt", ["kiten"]],
      ] as const
    ) {
      await t.step(name, async () => {
        const url = new URL(`testdata/ask-door/${name}`, import.meta.url);
        assertEquals(
          (await run(file, line)).stdout,
          await Deno.readTextFile(url),
        );
      });
    }
  }));

Deno.test("файл испорчен до справки: отказ, а не пустой список", () =>
  withPolicyFile(async (file) => {
    await run(file, ["policy"]);
    const out: string[] = [];
    const err: string[] = [];
    const io = makeFakeIo({
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
    const code = await lineEntry(consentOf(file))(["ask"], io, {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    }, { nativeCall: () => {}, note: () => {} } as unknown as InvokeJournal);
    assertEquals(code, 2);
    assertEquals(out, []);
    assertEquals(
      err.join(""),
      'mpu ask: правила подтверждения: неизвестное решение "maybe"\n',
    );
  }));
