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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { commands, legacyCommands, surfaces } from "./mod.ts";
import type { CommandIo } from "../command/mod.ts";
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
  return await Deno.readTextFile(
    new URL(`testdata/${name}`, import.meta.url),
  );
}

/** Все имена дерева команд: они обязаны быть на справочных поверхностях. */
function allNames(): readonly string[] {
  return [
    ...commands.map((command) => command.path[0]),
    ...legacyCommands.map((command) => command.path[0]),
    ...surfaces.map((surface) => surface.path[0]),
  ].filter((name, index, all) => all.indexOf(name) === index);
}

Deno.test("mpu --help ≡ mpu -h, голый mpu — тот же текст с exit 2", async () => {
  const long = await run(["--help"]);
  const short = await run(["-h"]);
  const bare = await run([]);
  assertEquals(long.code, 0);
  assertEquals(short.code, 0);
  assertEquals(short.stdout, long.stdout);
  // Отклонение-preserve: тот же текст, но вызов без команды — ошибка.
  assertEquals(bare.stdout, long.stdout);
  assertEquals(bare.code, 2);
});

Deno.test("help-root.txt: состав и тексты, а не рамки", async () => {
  const { stdout } = await run(["--help"]);
  const fixture = await golden("help-root.txt");
  // Описание CLI — дословно из эталона (отклонение оставляет его в силе).
  assertStringIncludes(
    stdout,
    "Monorepo Python utilities — multi-purpose CLI for ad-hoc operations.",
  );
  // Состав полный: 57 имён против 54 в дрейфующем эталоне.
  for (const name of allNames()) assertStringIncludes(stdout, name);
  // Рамок оригинала нет — и это осознанно.
  assertEquals(stdout.includes("╭─"), false);
  assertEquals(fixture.includes("╭─"), true);
});

Deno.test("help-list.txt: заголовок, футер, колонка и порядок реестра", async () => {
  const { code, stdout } = await run(["help"]);
  assertEquals(code, 0);
  const fixture = await golden("help-list.txt");
  assertStringIncludes(stdout, "Available commands:");
  assertStringIncludes(stdout, "Run `<command> --help` for detailed usage.");
  assertEquals(fixture.startsWith("Available commands:"), true);

  // Отклонение (б): порядок — реестра, не алфавита. Проверяем по паре
  // имён, у которых эти порядки различаются.
  const positionOf = (name: string) => stdout.indexOf(`mpu ${name} `);
  assertEquals(positionOf("search") < positionOf("config"), true);
  // В эталоне тот же порядок алфавитный — и это расхождение осознанное.
  const inFixture = (name: string) => fixture.indexOf(`mpu ${name} `);
  assertEquals(inFixture("config") < inFixture("search"), true);

  // Отклонение (г): состав полный, включая пропущенные в эталоне.
  for (const missing of ["api", "init", "version"]) {
    assertStringIncludes(stdout, `mpu ${missing}`);
    assertEquals(fixture.includes(`mpu ${missing} `), false);
  }
});

Deno.test("help-help.txt и help-named-self.txt: справка самой mpu help", async () => {
  const viaFlag = await run(["help", "--help"]);
  const viaName = await run(["help", "mpu help"]);
  assertEquals(viaFlag.code, 0);
  assertEquals(viaName.code, 0);
  // Отклонение (в): именованный рендер даёт ровно тот же текст, что и
  // `--help`, — в оригинале они расходились (см. два эталона).
  assertEquals(viaName.stdout, viaFlag.stdout);
  assertStringIncludes(viaFlag.stdout, "mpu help");
  // Однострока — из слепка, как в эталоне.
  const fixture = await golden("help-help.txt");
  assertStringIncludes(
    fixture,
    "Список всех mpu команд с опциональной справкой.",
  );
  assertStringIncludes(
    viaFlag.stdout,
    "Список всех mpu команд с опциональной справкой.",
  );
  // И рекурсии нет: список команд при этом не печатается.
  assertEquals(viaName.stdout.includes("Available commands:"), false);
});

Deno.test("ошибки mpu help: unknown, пустая строка, голый kebab", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["does-not-exist", "err-help-unknown.txt", "неизвестное имя"],
    ["", "err-help-empty.txt", "пустая строка"],
    ["search", "err-help-bare-kebab.txt", "голый kebab вместо полного имени"],
  ];
  for (const [wanted, fixtureName, title] of cases) {
    await t.step(title, async () => {
      const { code, stdout, stderr } = await run(["help", wanted]);
      assertEquals(code, 2);
      assertEquals(stdout, "");
      // Ключевые фразы эталона — дословно.
      assertStringIncludes(stderr, `mpu help: unknown command '${wanted}'`);
      assertStringIncludes(stderr, "Known commands:");
      const fixture = await golden(fixtureName);
      assertStringIncludes(fixture, `unknown command '${wanted}'`);
      // Отклонение (г): наш список известных имён полнее эталонного.
      assertStringIncludes(stderr, "mpu version");
      assertEquals(fixture.includes("mpu version"), false);
    });
  }
});

Deno.test("err-unknown-command.txt: фраза и код неизвестной команды", async () => {
  const { code, stdout, stderr } = await run(["totally-bogus-command"]);
  assertEquals(code, 2);
  assertEquals(stdout, "");
  assertStringIncludes(stderr, "No such command 'totally-bogus-command'.");
  assertStringIncludes(stderr, "Try 'mpu -h' for help.");
  const fixture = await golden("err-unknown-command.txt");
  assertStringIncludes(fixture, "No such command 'totally-bogus-command'.");
});

Deno.test("err-version-flag.txt: --version на корне — не флаг", async () => {
  const { code, stdout, stderr } = await run(["--version"]);
  assertEquals(code, 2);
  assertEquals(stdout, "");
  assertStringIncludes(stderr, "No such option");
  assertStringIncludes(stderr, "--version");
  const fixture = await golden("err-version-flag.txt");
  assertStringIncludes(fixture, "No such option");
});

Deno.test("version.txt: одна строка версии", async () => {
  const { code, stdout, stderr } = await run(["version"]);
  assertEquals(code, 0);
  assertEquals(stderr, "");
  // Байтовая форма: ровно строка версии с переводом строки.
  assertEquals(stdout, `${VERSION}\n`);
  // Эталон снят с реализации той же версии — значение совпадает.
  assertEquals((await golden("version.txt")).trim(), VERSION);
});

Deno.test("version-help.txt: справка version, а не версия", async () => {
  const { code, stdout } = await run(["version", "--help"]);
  assertEquals(code, 0);
  assertStringIncludes(stdout, "mpu version");
  // Однострока эталона — та же, что в реестре (обе из слепка).
  assertStringIncludes(stdout, "Show mpu version.");
  assertStringIncludes(await golden("version-help.txt"), "Show mpu version.");
});

Deno.test("help-named-search.txt и subcmd-help.txt: справку печатает подпроцесс", async (t) => {
  // Эталоны сквозного поведения: flag-level текст справки команд
  // маршрута `legacy` приходит от Python-реализации, которой в
  // песочнице нет. Проверяем стык — argv и проход вывода насквозь;
  // байтовую сверку с этими двумя эталонами делает оператор.
  const cases: readonly (readonly [string, readonly string[], string[]])[] = [
    [
      'mpu help "mpu sheet"',
      ["help", "mpu sheet"],
      ["sheet", "--help"],
    ],
    ["mpu sheet get --help", ["sheet", "get", "--help"], [
      "sheet",
      "get",
      "--help",
    ]],
  ];

  for (const [title, argv, expectedArgv] of cases) {
    await t.step(title, async () => {
      const calls: string[][] = [];
      const printed =
        "Usage: mpu sheet [OPTIONS] COMMAND\n\nСправка от реализации.\n";
      const { code, stdout } = await run(argv, {
        runLegacy: (_bin, args) => {
          calls.push([...args]);
          return Promise.resolve({ code: 0, stdout: printed, stderr: "" });
        },
        readConfigStore: () => Promise.resolve(undefined),
      });
      assertEquals(code, 0);
      assertEquals(calls, [expectedArgv]);
      // Насквозь: реестр текст не переупаковывает и не дополняет.
      assertEquals(stdout, printed);
    });
  }
});

Deno.test("эталоны справки legacy остаются эталонами оператора", async () => {
  // Здесь фиксируется только то, что сессия проверить может: эталоны на
  // месте и описывают ту же команду, что видит реестр.
  assertStringIncludes(await golden("subcmd-help.txt"), "Usage: mpu sheet get");
  assertEquals(
    legacyCommands.some((command) => command.path.join(" ") === "sheet"),
    true,
  );
  // `help-named-search.txt` остаётся в канале, но эталоном поведения
  // быть перестал: `search` переехал на маршрут `native` и печатает
  // теперь свою справку, а не подпроцессную (вопрос спецификатору).
  assertStringIncludes(
    await golden("help-named-search.txt"),
    "Usage: mpu search",
  );
  assertEquals(
    legacyCommands.some((command) => command.path.join(" ") === "search"),
    false,
  );
});
