/**
 * Справочные поверхности против golden-эталонов
 * (`platform/registry.md`, «Golden-примеры»). Эталоны сняты с живой
 * Python-версии и скопированы в testdata.
 *
 * Байтами сверяется не всё: четыре отклонения спеки с вердиктом `fix`
 * означают осознанное расхождение с эталоном, и тест обязан проверять
 * то свойство, которое отклонение оставляет в силе, а не букву:
 *
 *   а) оформление (рамки, цвета) не воспроизводится — сверяются состав,
 *      порядок, тексты однострок, ключевые фразы ошибок и exit-коды;
 *   б) порядок `mpu help` — порядок реестра, а не алфавит оригинала;
 *   в) `mpu help <имя>` даёт ровно тот же текст, что `<имя> --help`;
 *   г) состав поверхностей полный (57 имён), а эталоны несут дрейф
 *      оригинала (54).
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
import { commands, surfaces } from "./mod.ts";
import type { CommandIo } from "@mpu/command";
import { VERSION } from "../version.ts";

/** Прогон CLI с захватом обоих потоков и кода возврата. */
async function run(
  argv: readonly string[],
  overrides: Partial<CommandIo> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, makeFakeIo(overrides), {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

async function golden(name: string): Promise<string> {
  return await readFile(new URL(`testdata/${name}`, import.meta.url), "utf8");
}

/** Все имена дерева команд: они обязаны быть на справочных поверхностях. */
function allNames(): readonly string[] {
  return [
    ...commands.map((command) => command.path[0]),
    ...surfaces.map((surface) => surface.path[0]),
  ].filter((name, index, all) => all.indexOf(name) === index);
}

it("mpu --help ≡ mpu -h, голый mpu — тот же текст с exit 2", async () => {
  const long = await run(["--help"]);
  const short = await run(["-h"]);
  const bare = await run([]);
  expect(long.code).toBe(0);
  expect(short.code).toBe(0);
  expect(short.stdout).toStrictEqual(long.stdout);
  // Отклонение-preserve: тот же текст, но вызов без команды — ошибка.
  expect(bare.stdout).toStrictEqual(long.stdout);
  expect(bare.code).toBe(2);
});

it("help-root.txt: состав и тексты, а не рамки", async () => {
  const { stdout } = await run(["--help"]);
  const fixture = await golden("help-root.txt");
  // Описание CLI — своё, не из эталона: эталон описывает прежний
  // Python-инструмент, которого нет (`platform/monolith-removal.md`).
  // Сам голден `help-root.txt` намеренно не трогается — он остаётся
  // снимком оригинала.
  expect(stdout).toContain(
    "mpu — тонкий клиент сервера строк: команды исполняет mpu-back.",
  );
  // Состав полный: 57 имён против 54 в дрейфующем эталоне.
  const names = allNames();
  // Пустой список имён прошёл бы цикл молча: проверка перестала бы
  // что-либо утверждать.
  expect(names.length > 0, "имён реестра нет вовсе").toBe(true);
  for (const name of names) expect(stdout).toContain(name);
  // Рамок оригинала нет — и это осознанно.
  expect(stdout.includes("╭─")).toBe(false);
  expect(fixture.includes("╭─")).toBe(true);
});

it("help-list.txt: заголовок, футер, колонка и порядок реестра", async () => {
  const { code, stdout } = await run(["help"]);
  expect(code).toBe(0);
  const fixture = await golden("help-list.txt");
  expect(stdout).toContain("Available commands:");
  expect(stdout).toContain("Run `<command> --help` for detailed usage.");
  expect(fixture.startsWith("Available commands:")).toBe(true);

  // Отклонение (б): порядок — реестра, не алфавита. Проверяем по паре
  // имён, у которых эти порядки различаются.
  const positionOf = (name: string) => stdout.indexOf(`mpu ${name} `);
  expect(positionOf("search") < positionOf("config")).toBe(true);
  // В эталоне тот же порядок алфавитный — и это расхождение осознанное.
  const inFixture = (name: string) => fixture.indexOf(`mpu ${name} `);
  expect(inFixture("config") < inFixture("search")).toBe(true);

  // Отклонение (г): состав полный, включая пропущенные в эталоне.
  for (const missing of ["api", "init", "version"]) {
    expect(stdout).toContain(`mpu ${missing}`);
    expect(fixture.includes(`mpu ${missing} `)).toBe(false);
  }
});

it("help-help.txt и help-named-self.txt: справка самой mpu help", async () => {
  const viaFlag = await run(["help", "--help"]);
  const viaName = await run(["help", "mpu help"]);
  expect(viaFlag.code).toBe(0);
  expect(viaName.code).toBe(0);
  // Отклонение (в): именованный рендер даёт ровно тот же текст, что и
  // `--help`, — в оригинале они расходились (см. два эталона).
  expect(viaName.stdout).toStrictEqual(viaFlag.stdout);
  expect(viaFlag.stdout).toContain("mpu help");
  // Однострока — из слепка, как в эталоне.
  const fixture = await golden("help-help.txt");
  expect(fixture).toContain("Список всех mpu команд с опциональной справкой.");
  expect(viaFlag.stdout).toContain(
    "Список всех mpu команд с опциональной справкой.",
  );
  // И рекурсии нет: список команд при этом не печатается.
  expect(viaName.stdout.includes("Available commands:")).toBe(false);
});

describe("ошибки mpu help: unknown, пустая строка, голый kebab", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["does-not-exist", "err-help-unknown.txt", "неизвестное имя"],
    ["", "err-help-empty.txt", "пустая строка"],
    ["search", "err-help-bare-kebab.txt", "голый kebab вместо полного имени"],
  ];
  for (const [wanted, fixtureName, title] of cases) {
    it(title, async () => {
      const { code, stdout, stderr } = await run(["help", wanted]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      // Ключевые фразы эталона — дословно.
      expect(stderr).toContain(`mpu help: unknown command '${wanted}'`);
      expect(stderr).toContain("Known commands:");
      const fixture = await golden(fixtureName);
      expect(fixture).toContain(`unknown command '${wanted}'`);
      // Отклонение (г): наш список известных имён полнее эталонного.
      expect(stderr).toContain("mpu version");
      expect(fixture.includes("mpu version")).toBe(false);
    });
  }
});

it("err-unknown-command.txt: фраза и код неизвестной команды", async () => {
  const { code, stdout, stderr } = await run(["totally-bogus-command"]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("No such command 'totally-bogus-command'.");
  expect(stderr).toContain("Try 'mpu -h' for help.");
  const fixture = await golden("err-unknown-command.txt");
  expect(fixture).toContain("No such command 'totally-bogus-command'.");
});

it("err-version-flag.txt: --version на корне — не флаг", async () => {
  const { code, stdout, stderr } = await run(["--version"]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("No such option");
  expect(stderr).toContain("--version");
  const fixture = await golden("err-version-flag.txt");
  expect(fixture).toContain("No such option");
});

it("version.txt: одна строка версии", async () => {
  const { code, stdout, stderr } = await run(["version"]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  // Байтовая форма: ровно строка версии с переводом строки.
  expect(stdout).toStrictEqual(`${VERSION}\n`);
  // Эталон снят с реализации той же версии — значение совпадает.
  expect((await golden("version.txt")).trim()).toStrictEqual(VERSION);
});

it("version-help.txt: справка version, а не версия", async () => {
  const { code, stdout } = await run(["version", "--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("mpu version");
  // Однострока эталона — та же, что в реестре (обе из слепка).
  expect(stdout).toContain("Show mpu version.");
  expect(await golden("version-help.txt")).toContain("Show mpu version.");
});

it("переехавшее семейство: индекс собирает реестр", async () => {
  // `sheet` ушла с маршрута `legacy` целиком, и её индекс собирает
  // реестр — эталоны справки Python по ней (`help-named-sheet.txt`,
  // `subcmd-help.txt`) удалены вместе с маршрутом: эталон,
  // описывающий несуществующий путь, хуже, чем его отсутствие.
  const { stdout } = await run(["sheet", "--help"]);
  for (const name of ["get", "set", "open", "alias", "cache"]) {
    expect(stdout).toContain(name);
  }
});
