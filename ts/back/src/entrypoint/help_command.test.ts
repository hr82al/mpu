/**
 * `mpu help` и `mpu help <имя>` (`platform/registry.md`). Состав
 * списка — единый реестр: в оригинале рукописный список дрейфовал от
 * `--help`, и это отклонение с вердиктом `fix`.
 */

import { describe, expect, it } from "vitest";
import { runCli } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { commands } from "../registry/mod.ts";
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

it("mpu help: список всех команд обоих маршрутов", async () => {
  const cli = makeCli();
  expect(await cli.run("help")).toBe(0);
  const text = cli.stdout();
  expect(text).toContain("Available commands:");
  expect(text).toContain("Run `<command> --help` for detailed usage.");
  // Ни одна запись реестра не потеряна — состав собирается из него.
  for (const command of commands) {
    expect(text).toContain(`mpu ${command.path.join(" ")}`);
  }
  // И сама справочная подкоманда тоже в списке (спека).
  expect(text).toContain("mpu help");
  expect(cli.stderr()).toBe("");
});

it("mpu help --help — своя справка, а не список", async () => {
  const cli = makeCli();
  expect(await cli.run("help", "--help")).toBe(0);
  expect(cli.stdout()).toContain("Использование: mpu help");
  expect(cli.stdout()).toContain("Список всех mpu команд");
  expect(cli.stdout().includes("Available commands:")).toBe(false);
});

describe("mpu help <имя>: справка целевой команды", () => {
  it("полное имя команды маршрута native", async () => {
    const cli = makeCli();
    expect(await cli.run("help", "mpu xlsx get")).toBe(0);
    // Тот же текст, что у `mpu xlsx get --help` (отклонение-fix).
    const direct = makeCli();
    await direct.run("xlsx", "get", "--help");
    expect(cli.stdout()).toStrictEqual(direct.stdout());
  });
});

describe("mpu help: неизвестное имя — exit 2 и список известных", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["не-команда", "does-not-exist"],
    ["пустая строка", ""],
    ["голый kebab вместо полного имени", "sheet"],
  ];
  for (const [title, wanted] of cases) {
    it(title, async () => {
      const cli = makeCli();
      expect(await cli.run("help", wanted)).toBe(2);
      expect(cli.stderr()).toContain(`mpu help: unknown command '${wanted}'`);
      expect(cli.stderr()).toContain("Known commands: mpu xlsx ls");
      expect(cli.stdout()).toBe("");
    });
  }
});

it('mpu help "mpu help": собственная справка без рекурсии', async () => {
  const cli = makeCli();
  expect(await cli.run("help", "mpu help")).toBe(0);
  expect(cli.stdout()).toContain("mpu help");
  // Список команд при этом не печатается: спросили одну запись.
  expect(cli.stdout().includes("Available commands:")).toBe(false);
});
