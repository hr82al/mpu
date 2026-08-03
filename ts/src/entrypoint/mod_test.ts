import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "./mod.ts";
import type { CommandIo } from "../command/mod.ts";

/** Точка входа маршрутизирует и печатает; io при этом не нужен. */
function makeCli() {
  const out: string[] = [];
  const err: string[] = [];
  const mustNotTouch = (what: string) => () => {
    throw new Error(`${what} must not be touched`);
  };
  const io: CommandIo = {
    env: () => undefined,
    cwd: () => "/nowhere",
    readFile: mustNotTouch("readFile"),
    readTextFile: mustNotTouch("readTextFile"),
    readTextStdin: mustNotTouch("stdin"),
    readConfigStore: () => Promise.resolve(undefined),
    writeConfigStore: mustNotTouch("writeConfigStore"),
    launchOpener: mustNotTouch("opener"),
  };
  const output = {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  };
  return {
    run: (...args: string[]) => runCli(args, io, output),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

Deno.test("корень: bare печатает индекс и падает, --help — тот же с 0", async () => {
  const bare = makeCli();
  assertEquals(await bare.run(), 2);
  const help = makeCli();
  assertEquals(await help.run("--help"), 0);
  assertEquals(bare.stdout(), help.stdout());
  assertStringIncludes(help.stdout(), "Подкоманды:");
  // Индекс собирается из реестра: группа верхнего уровня видна.
  assertStringIncludes(help.stdout(), "xlsx");
});

Deno.test("корень: неизвестные имя и опция — exit 2", async (t) => {
  await t.step("неизвестная команда", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("wat"), 2);
    assertEquals(
      cli.stderr(),
      "No such command 'wat'.\nTry 'mpu -h' for help.\n",
    );
  });
  await t.step("неизвестная опция", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("--version"), 2);
    assertEquals(cli.stderr(), `No such option "--version"\n`);
  });
});

Deno.test("--json: общий параметр на любом уровне вложенности", async (t) => {
  await t.step("структурный результат вместо текста", async () => {
    const cli = makeCli();
    const code = await cli.run("xlsx", "alias", "ls", "--json");
    assertEquals(code, 0);
    assertEquals(JSON.parse(cli.stdout()), { aliases: [] });
  });
  await t.step("текстовая форма того же вызова", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "ls"), 0);
    assertEquals(cli.stdout(), "");
  });
  await t.step("флаг снимается до разбора аргументов команды", async () => {
    // Команда о существовании --json не знает: в её схеме его нет, и
    // «unknown option» она не увидит.
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "--json", "alias", "ls"), 0);
    assertEquals(JSON.parse(cli.stdout()), { aliases: [] });
  });
  await t.step("после «--» флаг остаётся аргументом команды", async () => {
    const cli = makeCli();
    const code = await cli.run("xlsx", "get", "--", "--json");
    // «--json» ушёл в позиционные диапазоны (голое имя листа), поэтому
    // разбор дошёл до резолва пути, а формы вывода не запрашивал:
    // stdout пуст, ошибка — про незаданный путь.
    assertEquals(code, 2);
    assertEquals(cli.stdout(), "");
    assertStringIncludes(cli.stderr(), "путь к .xlsx не задан");
  });
});

Deno.test("группа: индекс уровня и неизвестная подкоманда", async (t) => {
  await t.step("bare группа — индекс и exit 2", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias"), 2);
    assertStringIncludes(cli.stdout(), "add");
    assertStringIncludes(cli.stdout(), "rm");
  });
  await t.step("--help группы — тот же индекс и exit 0", async () => {
    const bare = makeCli();
    await bare.run("xlsx", "alias");
    const help = makeCli();
    assertEquals(await help.run("xlsx", "alias", "--help"), 0);
    assertEquals(help.stdout(), bare.stdout());
  });
  await t.step("неизвестная подкоманда группы — exit 2", async () => {
    const cli = makeCli();
    assertEquals(await cli.run("xlsx", "alias", "wat"), 2);
    assertEquals(
      cli.stderr(),
      "No such command 'xlsx alias wat'.\nTry 'mpu -h' for help.\n",
    );
  });
});

Deno.test("листовая справка печатается вместо исполнения", async () => {
  const cli = makeCli();
  assertEquals(await cli.run("xlsx", "get", "--help"), 0);
  assertStringIncludes(cli.stdout(), "Использование: mpu xlsx get");
  assertStringIncludes(cli.stdout(), "значения диапазонов книги");
});
