/**
 * Дерево реестра глазами цепочки: достижимость путей, рефлексия групп,
 * справка без исполнения и намеренные отличия от `runCli`
 * (`platform/registry-objects.md`, «Известные отклонения»).
 */

import { GRAMMAR } from "../messages/mod.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { childrenOf, commands, groups, surfaces } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { lineEntry } from "./mod.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";

/** Прогон строки с файлом правил `file`: потоки, код и отметки журнала. */
async function run(
  file: string,
  argv: readonly string[],
  overrides: Partial<CommandIo> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const native: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void native.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const code = await lineEntry(consentOf(file))(argv, makeFakeIo(overrides), {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  }, journal);
  return { code, stdout: out.join(""), stderr: err.join(""), native };
}

Deno.test("справка команды не исполняет её", (t) =>
  withPolicyFile(async (file) => {
    for (
      const argv of [["kiten", "card", "--help"], ["kiten", "card", "help"]]
    ) {
      await t.step(argv.join(" "), async () => {
        const { code, stdout, stderr, native } = await run(file, argv);
        assertEquals(code, 0);
        assertEquals(stderr, "");
        assertEquals(native, [], "команда исполнялась");
        assertStringIncludes(stdout, "mpu kiten card");
      });
    }
  }));

Deno.test("группа без подкоманды — справка и код 2", () =>
  withPolicyFile(async (file) => {
    const { code, stdout, native } = await run(file, ["kiten"]);
    assertEquals(code, 2);
    assertEquals(native, []);
    assertStringIncludes(stdout, "Использование: mpu kiten <сообщение>");
    assertStringIncludes(stdout, "card");
  }));

Deno.test("непонятое слово: ближайшие и путь приёмника", (t) =>
  withPolicyFile(async (file) => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["kitn"], "mpu: не понимает kitn; ближайшие: kiten, it\n"],
      // Ребёнок `move` — две правки от `nope`, но при посеве он `ask`:
      // обычный взгляд его не называет, и в «ближайших» его нет
      // (`platform/ask-door.md`).
      [["kiten", "nope"], "mpu kiten: не понимает nope\n"],
      // Отклонение спеки: у `runCli` здесь «No such command 'wb-loader 777'».
      [["wb-loader", "777", "cards"], "mpu wb-loader: не понимает 777\n"],
    ];
    for (const [argv, text] of cases) {
      await t.step(argv.join(" "), async () => {
        const { code, stdout, stderr, native } = await run(file, argv);
        assertEquals(code, 2);
        assertEquals(stdout, "");
        assertEquals(stderr, text);
        assertEquals(native, []);
      });
    }
  }));

Deno.test("ошибка разбора печатается как есть", () =>
  withPolicyFile(async (file) => {
    const { code, stderr } = await run(file, ["kiten", "field", "card:"]);
    assertEquals(code, 2);
    assertEquals(stderr, "у ключа card нет значения\n");
  }));

Deno.test("каждый путь реестра достижим: справка листа без исполнения", () =>
  withPolicyFile(async (file) => {
    // `help` из строки убирается режимом справки, поэтому эта поверхность
    // проверяется отдельно (отклонение спеки).
    const leaves = [
      ...commands.map((command) => command.path),
      ...surfaces.map((surface) => surface.path).filter(([name]) =>
        name !== "help"
      ),
    ];
    assert(leaves.length > 200, `листов реестра ${leaves.length}`);
    for (const path of leaves) {
      const { code, stdout, native } = await run(file, [...path, "--help"]);
      assertEquals(code, 0, path.join(" "));
      assertEquals(native, [], path.join(" "));
      assertStringIncludes(stdout, `mpu ${path.join(" ")}`);
    }
  }));

/** Селекторы из ответа `messages … end json`. */
function selectorsOf(stdout: string): string[] {
  return JSON.parse(stdout).map((line: { selector: string }) => line.selector);
}

Deno.test("messages группы — ровно её дети, когда разрешено всё", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    for (const group of groups) {
      const { code, stdout } = await run(file, [
        ...group.path,
        "messages",
        GRAMMAR.close,
        "json",
      ]);
      assertEquals(code, 0, group.path.join(" "));
      assertEquals(
        selectorsOf(stdout),
        childrenOf(group.path).map((child) => child.name).sort(),
        group.path.join(" "),
      );
    }
  }));

Deno.test("messages корня — дети, правила, вход ask, дополнение и it", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const { code, stdout } = await run(file, [
      "messages",
      GRAMMAR.close,
      "json",
    ]);
    assertEquals(code, 0);
    assertEquals(
      selectorsOf(stdout),
      [
        ...childrenOf([]).map((child) => child.name),
        "policy",
        "allow:",
        "ask",
        "ask:",
        "complete:",
        "deny:",
        "forget:",
        "it",
      ].sort(),
    );
  }));
