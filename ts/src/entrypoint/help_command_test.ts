/**
 * `mpu help` и `mpu help <имя>` (`platform/registry.md`). Состав
 * списка — единый реестр: в оригинале рукописный список дрейфовал от
 * `--help`, и это отклонение с вердиктом `fix`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { commands, legacyCommands } from "../registry/mod.ts";
import type { CommandIo } from "../command/mod.ts";

function makeCli(overrides: Partial<CommandIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    run: (...argv: string[]) =>
      runCli(argv, makeFakeIo(overrides), {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      }),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

Deno.test("mpu help: список всех команд обоих маршрутов", async () => {
  const cli = makeCli();
  assertEquals(await cli.run("help"), 0);
  const text = cli.stdout();
  assertStringIncludes(text, "Available commands:");
  assertStringIncludes(text, "Run `<command> --help` for detailed usage.");
  // Ни одна запись реестра не потеряна — состав собирается из него.
  for (const command of [...commands, ...legacyCommands]) {
    assertStringIncludes(text, `mpu ${command.path.join(" ")}`);
  }
  // И сама справочная подкоманда тоже в списке (спека).
  assertStringIncludes(text, "mpu help");
  assertEquals(cli.stderr(), "");
});

Deno.test("mpu help --help — своя справка, а не список", async () => {
  const cli = makeCli();
  assertEquals(await cli.run("help", "--help"), 0);
  assertStringIncludes(cli.stdout(), "Использование: mpu help");
  assertStringIncludes(cli.stdout(), "Список всех mpu команд");
  assertEquals(cli.stdout().includes("Available commands:"), false);
});

Deno.test("mpu help <имя>: справка целевой команды", async (t) => {
  await t.step("полное имя команды маршрута native", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("help", "mpu xlsx get"), 0);
    // Тот же текст, что у `mpu xlsx get --help` (отклонение-fix).
    const direct = makeCli();
    await direct.run("xlsx", "get", "--help");
    assertEquals(cli.stdout(), direct.stdout());
  });

  await t.step("справку legacy-команды печатает подпроцесс", async () => {
    const calls: string[][] = [];
    const cli = makeCli({
      runLegacy: (_bin, args) => {
        calls.push([...args]);
        return Promise.resolve({
          code: 0,
          stdout: "Usage: mpu sheet …\n",
          stderr: "",
        });
      },
      readConfigStore: () =>
        Promise.resolve(
          JSON.stringify({ values: { "mcp.legacy_bin": "/bin/echo" } }),
        ),
    });
    assertEquals(await cli.run("help", "mpu sheet"), 0);
    // Тот же вызов, что у `mpu sheet --help`: реестр текст не сочиняет.
    assertEquals(calls, [["sheet", "--help"]]);
    assertEquals(cli.stdout(), "Usage: mpu sheet …\n");
  });
});

Deno.test("mpu help: неизвестное имя — exit 2 и список известных", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["не-команда", "does-not-exist"],
    ["пустая строка", ""],
    ["голый kebab вместо полного имени", "sheet"],
  ];
  for (const [title, wanted] of cases) {
    await t.step(title, async () => {
      const cli = makeCli();
      assertEquals(await cli.run("help", wanted), 2);
      assertStringIncludes(
        cli.stderr(),
        `mpu help: unknown command '${wanted}'`,
      );
      assertStringIncludes(cli.stderr(), "Known commands: mpu xlsx ls");
      assertEquals(cli.stdout(), "");
    });
  }
});

Deno.test('mpu help "mpu help": собственная справка без рекурсии', async () => {
  const cli = makeCli();
  assertEquals(await cli.run("help", "mpu help"), 0);
  assertStringIncludes(cli.stdout(), "mpu help");
  // Список команд при этом не печатается: спросили одну запись.
  assertEquals(cli.stdout().includes("Available commands:"), false);
});
