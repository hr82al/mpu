/**
 * Дерево реестра глазами цепочки: достижимость путей, рефлексия групп,
 * справка без исполнения и намеренные отличия от `runCli`
 * (`platform/registry-objects.md`, «Известные отклонения»).
 */

import { GRAMMAR } from "../messages/mod.ts";
import { assert, describe, expect, it } from "vitest";
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

describe("справка команды не исполняет её", () => {
  for (
    const argv of [["kiten", "card", "--help"], ["kiten", "card", "help"]]
  ) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        const { code, stdout, stderr, native } = await run(file, argv);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(native, "команда исполнялась").toStrictEqual([]);
        expect(stdout).toContain("mpu kiten card");
      }));
  }
});

it("группа без подкоманды — справка и код 2", () =>
  withPolicyFile(async (file) => {
    const { code, stdout, native } = await run(file, ["kiten"]);
    expect(code).toBe(2);
    expect(native).toStrictEqual([]);
    expect(stdout).toContain("Использование: mpu kiten <сообщение>");
    expect(stdout).toContain("card");
  }));

describe("непонятое слово: ближайшие и путь приёмника", () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [["kitn"], "mpu: не понимает kitn; ближайшие: kiten\n"],
    // Ребёнок `move` — две правки от `nope`, но при посеве он `ask`:
    // обычный взгляд его не называет, и в «ближайших» его нет
    // (`platform/ask-door.md`).
    [["kiten", "nope"], "mpu kiten: не понимает nope\n"],
    // Отклонение спеки: у `runCli` здесь «No such command 'wb-loader 777'».
    [["wb-loader", "777", "cards"], "mpu wb-loader: не понимает 777\n"],
  ];
  for (const [argv, text] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        const { code, stdout, stderr, native } = await run(file, argv);
        expect(code).toBe(2);
        expect(stdout).toBe("");
        expect(stderr).toStrictEqual(text);
        expect(native).toStrictEqual([]);
      }));
  }
});

it("ошибка разбора печатается как есть", () =>
  withPolicyFile(async (file) => {
    const { code, stderr } = await run(file, ["kiten", "field", "card:"]);
    expect(code).toBe(2);
    expect(stderr).toBe("у ключа card нет значения\n");
  }));

/**
 * Предел обходов реестра: под `deno test` они шли до ~6 с без предела, а
 * под нагрузкой соседних прогонов — в разы дольше; 5 с Vitest по
 * умолчанию красили бы занятую машину, а не дефект.
 */
const LONG_MS = 60_000;

it(
  "каждый путь реестра достижим: справка листа без исполнения",
  () =>
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
        expect(code, path.join(" ")).toBe(0);
        expect(native, path.join(" ")).toStrictEqual([]);
        expect(stdout).toContain(`mpu ${path.join(" ")}`);
      }
    }),
  LONG_MS,
);

/** Селекторы из ответа `messages … end json`. */
function selectorsOf(stdout: string): string[] {
  return JSON.parse(stdout).map((line: { selector: string }) => line.selector);
}

it(
  "messages группы — ровно её дети, когда разрешено всё",
  () =>
    withPolicyFile(async (file) => {
      allowEverything(file);
      for (const group of groups) {
        const { code, stdout } = await run(file, [
          ...group.path,
          "messages",
          GRAMMAR.close,
          "json",
        ]);
        expect(code, group.path.join(" ")).toBe(0);
        expect(selectorsOf(stdout), group.path.join(" ")).toStrictEqual(
          childrenOf(group.path).map((child) => child.name).sort(),
        );
      }
    }),
  LONG_MS,
);

it("messages корня — дети, правила, вход ask, дополнение, it и run:", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const { code, stdout } = await run(file, [
      "messages",
      GRAMMAR.close,
      "json",
    ]);
    expect(code).toBe(0);
    expect(selectorsOf(stdout)).toStrictEqual([
      ...childrenOf([]).map((child) => child.name),
      "policy",
      "allow:",
      "ask",
      "ask:",
      "complete:",
      "deny:",
      "forget:",
      "it",
      GRAMMAR.run,
    ].sort());
  }));
