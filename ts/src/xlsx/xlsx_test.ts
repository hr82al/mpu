import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import type { CommandIo } from "../command/mod.ts";
import { makeDenoIo } from "../runtime/mod.ts";
import { xlsxCommands } from "./mod.ts";

/** Плейсхолдер снапшот-каталога в golden-эталонах спеки. */
const SNAPSHOT_DIR = "{{SNAPSHOT_DIR}}";

const testdataUrl = (name: string) =>
  new URL(`testdata/${name}`, import.meta.url);

async function fixtureText(name: string): Promise<string> {
  return await Deno.readTextFile(testdataUrl(name));
}

async function fixtureB64(name: string): Promise<Uint8Array> {
  const b64 = await Deno.readTextFile(testdataUrl(name));
  return Uint8Array.from(
    atob(b64.replaceAll(/\s+/g, "")),
    (ch) => ch.codePointAt(0) ?? 0,
  );
}

interface TestCli {
  /** Исполняет `mpu xlsx …`: путь команды дописывается тестом. */
  readonly run: (...args: string[]) => Promise<number>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function makeTestCli(overrides: Partial<CommandIo> = {}): TestCli {
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
    ...overrides,
  };
  const output = {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  };
  return {
    run: (...args) => runCli(["xlsx", ...args], io, output),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/**
 * CLI с реальной файловой системой (только чтение/запись файлов из
 * настоящего io), cwd в dir и захватом вывода в буферы. Хранилище
 * конфига по умолчанию в dir/config; шаги, которым нужно заведомо
 * пустое, передают собственный storePath — иначе состояние хранилища
 * утекает между шагами одного каталога.
 */
function makeDirCli(
  dir: string,
  overrides: Partial<CommandIo> = {},
  storePath = "config/config.json",
): TestCli {
  const real = makeDenoIo(`${dir}/${storePath}`);
  return makeTestCli({
    readFile: real.readFile,
    readTextFile: real.readTextFile,
    readConfigStore: real.readConfigStore,
    writeConfigStore: real.writeConfigStore,
    env: () => undefined,
    cwd: () => dir,
    launchOpener: () => {
      throw new Error("opener must not be touched");
    },
    ...overrides,
  });
}

/** Временный каталог с sample.xlsx и broken.xlsx из testdata. */
async function withSampleDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(
      `${dir}/sample.xlsx`,
      await fixtureB64("sample.xlsx.b64"),
    );
    await Deno.copyFile(testdataUrl("broken.xlsx"), `${dir}/broken.xlsx`);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

interface GoldenCase {
  readonly args: readonly string[];
  readonly fixture: string;
  readonly exit: number;
  /** Поток эталона; по умолчанию stdout. */
  readonly stream?: "stderr";
}

const GOLDEN: readonly GoldenCase[] = [
  { args: ["ls", "-f", "sample.xlsx"], fixture: "ls.txt", exit: 0 },
  { args: ["ls", "-f", "sample.xlsx", "-l"], fixture: "ls-long.txt", exit: 0 },
  {
    args: ["ls", "-f", "sample.xlsx", "--json"],
    fixture: "ls-json.txt",
    exit: 0,
  },
  {
    args: ["get", "-f", "sample.xlsx", "Данные!A1:C3"],
    fixture: "get-range.json",
    exit: 0,
  },
  {
    args: ["get", "-f", "sample.xlsx", "Данные!A4:A6"],
    fixture: "get-formula-error-merge.json",
    exit: 0,
  },
  {
    args: ["get", "-f", "sample.xlsx", "Данные!A1:C2", "--tsv"],
    fixture: "get-tsv.txt",
    exit: 0,
  },
  {
    args: ["get", "-f", "sample.xlsx", "Данные!B2", "--raw"],
    fixture: "get-raw.txt",
    exit: 0,
  },
  {
    args: ["get", "-f", "sample.xlsx", "Пустой"],
    fixture: "get-empty-sheet.json",
    exit: 0,
  },
  {
    args: ["get", "-f", "sample.xlsx"],
    fixture: "err-no-ranges.txt",
    exit: 2,
    stream: "stderr",
  },
  {
    args: ["get", "-f", "broken.xlsx", "S!A1"],
    fixture: "err-not-zip.txt",
    exit: 1,
    stream: "stderr",
  },
  {
    args: ["get", "-f", "sample.xlsx", "Нет!A1"],
    fixture: "err-unknown-sheet.txt",
    exit: 1,
    stream: "stderr",
  },
];

Deno.test("golden: таблица эталонов спеки, байт-в-байт", async (t) => {
  await withSampleDir(async (dir) => {
    for (const goldenCase of GOLDEN) {
      await t.step(goldenCase.args.join(" "), async () => {
        // Плейсхолдер эталона подставляется тестом: снапшот-каталог —
        // свойство прогона, а не фикстуры (контракт спеки xlsx.md).
        const expected = (await fixtureText(goldenCase.fixture))
          .replaceAll(SNAPSHOT_DIR, dir);
        const first = makeDirCli(dir);
        const code = await first.run(...goldenCase.args);
        assertEquals(code, goldenCase.exit, first.stderr());
        const got = goldenCase.stream === "stderr"
          ? first.stderr()
          : first.stdout();
        assertEquals(got, expected);
        // Инвариант спеки: повторный вызов побитово идентичен.
        const second = makeDirCli(dir);
        await second.run(...goldenCase.args);
        const again = goldenCase.stream === "stderr"
          ? second.stderr()
          : second.stdout();
        assertEquals(again, got);
      });
    }
  });
});

Deno.test("get: конфликты флагов и режимов — до открытия файла", async (t) => {
  await t.step("--raw и --tsv вместе", async () => {
    const cli = makeTestCli();
    const code = await cli.run(
      "get",
      "-f",
      "нет-такого.xlsx",
      "S!A1",
      "--raw",
      "--tsv",
    );
    assertEquals(code, 2);
    assertEquals(
      cli.stderr(),
      "mpu xlsx: only one of --raw / --tsv can be set; " +
        "попробуй: mpu xlsx get --help\n",
    );
  });
  await t.step("--render вне both|values|formulas", async () => {
    const cli = makeTestCli();
    const code = await cli.run(
      "get",
      "-f",
      "x.xlsx",
      "S!A1",
      "--render",
      "wat",
    );
    assertEquals(code, 2);
    assertStringIncludes(cli.stderr(), `invalid --render value "wat"`);
  });
  await t.step("диапазон без листа и без --sheet", async () => {
    const cli = makeTestCli();
    const code = await cli.run("get", "-f", "x.xlsx", "A1:B2");
    assertEquals(code, 2);
    assertStringIncludes(cli.stderr(), "--sheet");
  });
});

Deno.test("get: --sheet, --from, stdin, дедупликация", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("--sheet: префикс и весь лист без диапазонов", async () => {
      const a = makeDirCli(dir);
      const codeA = await a.run(
        "get",
        "-f",
        "sample.xlsx",
        "B2",
        "--sheet",
        "Данные",
        "--raw",
      );
      assertEquals([codeA, a.stdout()], [0, "42"]);
      const b = makeDirCli(dir);
      const codeB = await b.run(
        "get",
        "-f",
        "sample.xlsx",
        "--sheet",
        "Пустой",
      );
      assertEquals(codeB, 0);
      assertStringIncludes(b.stdout(), `"cells": []`);
    });
    await t.step("--from файл + аргументы, дубликаты убраны", async () => {
      const ranges = `${dir}/ranges.txt`;
      await Deno.writeTextFile(
        ranges,
        "# комментарий\n\nДанные!B2\nДанные!A1\n",
      );
      const cli = makeDirCli(dir);
      const code = await cli.run(
        "get",
        "-f",
        "sample.xlsx",
        "Данные!B2",
        "--from",
        ranges,
        "--tsv",
      );
      assertEquals(code, 0);
      assertEquals(
        cli.stdout(),
        "range\tvalue\tformula\nДанные!B2\t42\t\nДанные!A1\tтовар\t\n",
      );
    });
    await t.step("плотный прямоугольник: пустые ячейки как null", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run("get", "-f", "sample.xlsx", "Данные!A4:C4");
      assertEquals(code, 0);
      assertEquals(
        cli.stdout(),
        `{
  "file": "${dir}/sample.xlsx",
  "cells": [
    {
      "range": "Данные!A4",
      "value": 84,
      "formula": "=B2*2"
    },
    {
      "range": "Данные!B4",
      "value": null
    },
    {
      "range": "Данные!C4",
      "value": null
    }
  ]
}`,
      );
    });
    await t.step("--from повторяется, порядок файлов сохранён", async () => {
      await Deno.writeTextFile(`${dir}/r1.txt`, "Данные!B2\n");
      await Deno.writeTextFile(`${dir}/r2.txt`, "Данные!A1\n");
      const cli = makeDirCli(dir);
      const code = await cli.run(
        "get",
        "-f",
        "sample.xlsx",
        "--from",
        `${dir}/r1.txt`,
        "--from",
        `${dir}/r2.txt`,
        "--tsv",
      );
      assertEquals(code, 0);
      assertEquals(
        cli.stdout(),
        "range\tvalue\tformula\nДанные!B2\t42\t\nДанные!A1\tтовар\t\n",
      );
    });
    await t.step("--from с несуществующим файлом — exit 1", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run(
        "get",
        "-f",
        "sample.xlsx",
        "--from",
        "нет.txt",
      );
      assertEquals(code, 1);
      assertEquals(
        cli.stderr(),
        `mpu xlsx: ranges file not found: "нет.txt"\n`,
      );
    });
    await t.step("дедупликация именно после префиксации --sheet", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run(
        "get",
        "-f",
        "sample.xlsx",
        "B2",
        "Данные!B2",
        "-n",
        "Данные",
        "--tsv",
      );
      assertEquals(code, 0);
      assertEquals(cli.stdout(), "range\tvalue\tformula\nДанные!B2\t42\t\n");
    });
    await t.step("битое хранилище конфига — exit 1", async () => {
      await Deno.mkdir(`${dir}/corrupt`, { recursive: true });
      await Deno.writeTextFile(`${dir}/corrupt/config.json`, "{oops");
      const cli = makeDirCli(dir, {}, "corrupt/config.json");
      const code = await cli.run("alias", "ls");
      assertEquals(code, 1);
      assertStringIncludes(cli.stderr(), "mpu xlsx: corrupt config store");
    });
    await t.step("--from - читает stdin", async () => {
      const cli = makeDirCli(dir, {
        readTextStdin: () => Promise.resolve("Данные!C2\n"),
      });
      const code = await cli.run(
        "get",
        "-f",
        "sample.xlsx",
        "--from",
        "-",
        "--raw",
      );
      assertEquals([code, cli.stdout()], [0, "True"]);
    });
    await t.step("--render values/formulas в результате", async () => {
      const values = makeDirCli(dir);
      await values.run(
        "get",
        "-f",
        "sample.xlsx",
        "Данные!A4",
        "--render",
        "values",
      );
      assertStringIncludes(values.stdout(), `"value": 84`);
      assertEquals(values.stdout().includes("formula"), false);
      const formulas = makeDirCli(dir);
      await formulas.run(
        "get",
        "-f",
        "sample.xlsx",
        "Данные!A4:A5",
        "--render",
        "formulas",
      );
      assertStringIncludes(formulas.stdout(), `"formula": "=B2*2"`);
      assertEquals(formulas.stdout().includes(`"value"`), false);
    });
  });
});

Deno.test("резолв пути: env и config, файл не найден", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("env MPU_XLSX", async () => {
      const cli = makeDirCli(dir, {
        env: (name) => name === "MPU_XLSX" ? `${dir}/sample.xlsx` : undefined,
      });
      assertEquals(await cli.run("ls"), 0);
      assertEquals(cli.stdout(), "Данные\nПустой\n");
    });
    await t.step("config xlsx.default", async () => {
      await Deno.mkdir(`${dir}/config`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/config/config.json`,
        JSON.stringify({
          values: { "xlsx.default": `${dir}/sample.xlsx` },
          aliases: {},
        }),
      );
      const cli = makeDirCli(dir);
      assertEquals(await cli.run("ls"), 0);
      assertEquals(cli.stdout(), "Данные\nПустой\n");
    });
    await t.step("путь не задан — текст спеки", async () => {
      // Собственное (пустое) хранилище: шаг выше записал xlsx.default.
      const cli = makeDirCli(dir, {}, "empty/config.json");
      const code = await cli.run("ls");
      assertEquals(code, 2);
      assertEquals(
        cli.stderr(),
        "mpu xlsx: путь к .xlsx не задан. Проверены (по порядку): " +
          "--file/-f, env MPU_XLSX, config xlsx.default; попробуй: " +
          "--file <путь>, export MPU_XLSX=<путь> " +
          "или задай config xlsx.default\n",
      );
    });
    await t.step("файл не найден — абсолютный путь в ошибке", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run("ls", "-f", "нет.xlsx");
      assertEquals(code, 1);
      assertEquals(
        cli.stderr(),
        `mpu xlsx: file not found: "${dir}/нет.xlsx"\n`,
      );
    });
  });
});

Deno.test("alias: add/ls/rm, права хранилища, использование", async (t) => {
  await withSampleDir(async (dir) => {
    const run = async (...args: string[]) => {
      const cli = makeDirCli(dir);
      const code = await cli.run(...args);
      return { code, out: cli.stdout(), err: cli.stderr() };
    };
    await t.step("add + использование алиаса", async () => {
      const added = await run("alias", "add", "probe", `${dir}/sample.xlsx`);
      assertEquals([added.code, added.out], [0, ""]);
      const used = await run("get", "-f", "probe", "Данные!B2", "--raw");
      assertEquals([used.code, used.out], [0, "42"]);
    });
    await t.step("права файла хранилища 0600 и при перезаписи", async () => {
      const path = `${dir}/config/config.json`;
      // mode на POSIX всегда есть; тесты не для Windows.
      const created = await Deno.stat(path);
      assertEquals(created.mode! & 0o777, 0o600, "при создании");
      await Deno.chmod(path, 0o644);
      assertEquals((await run("alias", "add", "perm", "x.xlsx")).code, 0);
      const rewritten = await Deno.stat(path);
      assertEquals(rewritten.mode! & 0o777, 0o600, "после перезаписи");
      assertEquals((await run("alias", "rm", "perm")).code, 0);
    });
    await t.step("ls текстом и как структурный результат", async () => {
      await run("alias", "add", "b", "second.xlsx");
      const plain = await run("alias", "ls");
      assertEquals(plain.out, `b\tsecond.xlsx\nprobe\t${dir}/sample.xlsx\n`);
      const json = await run("alias", "ls", "--json");
      assertEquals(JSON.parse(json.out), {
        aliases: [
          { name: "b", path: "second.xlsx" },
          { name: "probe", path: `${dir}/sample.xlsx` },
        ],
      });
    });
    await t.step("rm идемпотентен", async () => {
      assertEquals((await run("alias", "rm", "b")).code, 0);
      assertEquals((await run("alias", "rm", "b")).code, 0);
      const rest = await run("alias", "ls");
      assertEquals(rest.out, `probe\t${dir}/sample.xlsx\n`);
    });
    await t.step("невалидное имя и пустой путь — exit 2", async () => {
      const bad = await run("alias", "add", "кириллица", "x.xlsx");
      assertEquals(bad.code, 2);
      assertStringIncludes(bad.err, "invalid alias name");
      const empty = await run("alias", "add", "ok", "");
      assertEquals(empty.code, 2);
      assertStringIncludes(empty.err, "alias path must not be empty");
    });
    await t.step("ошибки аргументов: exit 2 без записи", async () => {
      const cases: readonly (readonly [readonly string[], string])[] = [
        [["alias", "rm"], "ожидает один аргумент"],
        [["alias", "add", "x"], "ожидает два аргумента"],
        [["alias", "add", "a", "b", "c"], `unexpected argument "c"`],
        [["alias", "wat"], "No such command 'xlsx alias wat'."],
      ];
      for (const [args, snippet] of cases) {
        // Хранилище бросает: разбор аргументов обязан упасть до него.
        const cli = makeTestCli({
          readConfigStore: () => {
            throw new Error("store must not be read");
          },
        });
        const code = await cli.run(...args);
        assertEquals(code, 2, args.join(" "));
        assertStringIncludes(cli.stderr(), snippet);
      }
    });
    await t.step("похожее на алиас, но не алиас — молча путь", async () => {
      const miss = await run("get", "-f", "ghost", "Данные!A1");
      assertEquals(miss.code, 1);
      assertEquals(miss.err, `mpu xlsx: file not found: "${dir}/ghost"\n`);
    });
  });
});

Deno.test("resolve: структурный результат и exit-коды", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("--json при нерезолве — exit 0, resolved null", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run("resolve", "--json");
      assertEquals(code, 0);
      const parsed = JSON.parse(cli.stdout());
      assertEquals(parsed.resolved, null);
      assertEquals(parsed.checked.length, 3);
      assertEquals(parsed.checked[0], {
        source: "flag",
        label: "--file/-f",
        value: null,
        used: false,
      });
    });
    await t.step("--json с флагом — источник и путь", async () => {
      const cli = makeDirCli(dir);
      await cli.run("resolve", "-f", "sample.xlsx", "--json");
      const parsed = JSON.parse(cli.stdout());
      assertEquals(parsed.resolved, {
        path: `${dir}/sample.xlsx`,
        source: "flag",
      });
    });
    await t.step("текстовая форма без пути — exit 2", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run("resolve");
      assertEquals(code, 2);
      // Диагностика печатается и при неуспехе: она и есть результат.
      assertStringIncludes(cli.stdout(), "--file/-f: (пусто)");
    });
    await t.step("текстовая форма с путём — exit 0 и победитель", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run("resolve", "-f", "sample.xlsx");
      assertEquals(code, 0);
      assertStringIncludes(cli.stdout(), "← используется");
      assertStringIncludes(cli.stdout(), `путь: ${dir}/sample.xlsx`);
    });
  });
});

Deno.test("open: --print и отсутствие открывателя", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("--print печатает путь, открыватель не зовётся", async () => {
      const cli = makeDirCli(dir);
      const code = await cli.run("open", "-f", "sample.xlsx", "--print");
      assertEquals([code, cli.stdout()], [0, `${dir}/sample.xlsx\n`]);
    });
    await t.step("первый доступный открыватель", async () => {
      const calls: string[] = [];
      const cli = makeDirCli(dir, {
        launchOpener: (cmd, target) => {
          calls.push(`${cmd} ${target}`);
          return cmd === "open";
        },
      });
      const code = await cli.run("open", "-f", "sample.xlsx");
      assertEquals(code, 0);
      assertEquals(calls, [
        `xdg-open ${dir}/sample.xlsx`,
        `open ${dir}/sample.xlsx`,
      ]);
    });
    await t.step("нет открывателя — exit 1 и подсказка --print", async () => {
      const cli = makeDirCli(dir, { launchOpener: () => false });
      const code = await cli.run("open", "-f", "sample.xlsx");
      assertEquals(code, 1);
      assertEquals(
        cli.stderr(),
        "mpu xlsx: no opener found (xdg-open, open); попробуй: --print\n",
      );
    });
  });
});

Deno.test("политики подкоманд — поимённо по таблице спеки", () => {
  // docs/specs/xlsx.md: «ls, get, resolve, alias ls — ro; open,
  // alias add, alias rm — rw». Профиль ro MCP-сервера собирается по
  // этим значениям, поэтому они закреплены поимённо, а не «объявлены».
  const expected: Readonly<Record<string, "ro" | "rw">> = {
    "xlsx ls": "ro",
    "xlsx get": "ro",
    "xlsx resolve": "ro",
    "xlsx alias ls": "ro",
    "xlsx open": "rw",
    "xlsx alias add": "rw",
    "xlsx alias rm": "rw",
  };
  const actual = Object.fromEntries(
    xlsxCommands.map((command) => [command.path.join(" "), command.policy]),
  );
  assertEquals(actual, expected);
});

Deno.test("справка: каждый уровень, без io, bare — exit 2", async (t) => {
  await t.step("bare и --help", async () => {
    const bare = makeTestCli();
    assertEquals(await bare.run(), 2);
    const help = makeTestCli();
    assertEquals(await help.run("--help"), 0);
    assertEquals(bare.stdout(), help.stdout());
    assertMatch(help.stdout(), /Подкоманды:/);
  });
  await t.step("листовые --help из индекса, без обращений к io", async () => {
    const index = makeTestCli();
    await index.run("--help");
    const names = [...index.stdout().matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]);
    assertEquals(names.length > 0, true, "индекс не распарсился");
    for (const name of names) {
      const leaf = makeTestCli();
      const code = await leaf.run(name, "--help");
      assertEquals(code, 0, `--help не работает у «${name}»`);
      assertEquals(leaf.stdout().length > 0, true, `пустая справка «${name}»`);
    }
  });
  await t.step("уровни alias: bare exit 2, листы exit 0", async () => {
    const bare = makeTestCli();
    assertEquals(await bare.run("alias"), 2);
    for (const sub of ["add", "ls", "rm"]) {
      const leaf = makeTestCli();
      const code = await leaf.run("alias", sub, "--help");
      assertEquals(code, 0, `alias ${sub} --help`);
      assertEquals(leaf.stdout().length > 0, true);
    }
  });
  await t.step("неизвестная подкоманда — exit 2", async () => {
    const cli = makeTestCli();
    assertEquals(await cli.run("wat"), 2);
    assertEquals(
      cli.stderr(),
      "No such command 'xlsx wat'.\nTry 'mpu -h' for help.\n",
    );
  });
});
