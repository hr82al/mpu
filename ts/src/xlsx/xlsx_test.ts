import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { makeDenoIo, runXlsx, type XlsxIo } from "./mod.ts";

/** Каталог, в котором снимались golden-фикстуры (подставляется). */
const SNAPSHOT_DIR = "/home/user/mr/mp/mpu/go/docs/specs/fixtures/xlsx";

const testdataUrl = (name: string) =>
  new URL(`testdata/${name}`, import.meta.url);

async function fixtureText(name: string): Promise<string> {
  if (name.endsWith(".b64")) {
    return new TextDecoder().decode(await fixtureB64(name));
  }
  return await Deno.readTextFile(testdataUrl(name));
}

async function fixtureB64(name: string): Promise<Uint8Array> {
  const b64 = await Deno.readTextFile(testdataUrl(name));
  return Uint8Array.from(
    atob(b64.replaceAll(/\s+/g, "")),
    (ch) => ch.codePointAt(0)!,
  );
}

interface TestIo {
  readonly io: XlsxIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function makeTestIo(
  overrides: Partial<XlsxIo> & { readonly cwd?: () => string },
): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const mustNotTouch = (what: string) => () => {
    throw new Error(`${what} must not be touched`);
  };
  const io: XlsxIo = {
    env: () => undefined,
    cwd: () => "/nowhere",
    readFile: mustNotTouch("readFile"),
    readTextFile: mustNotTouch("readTextFile"),
    readTextStdin: mustNotTouch("stdin"),
    readConfigStore: () => Promise.resolve(undefined),
    writeConfigStore: mustNotTouch("writeConfigStore"),
    launchOpener: mustNotTouch("opener"),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

/**
 * io с реальной файловой системой (только чтение/запись файлов из
 * настоящего io), cwd в dir и захватом вывода в буферы. Хранилище
 * конфига по умолчанию в dir/config; шаги, которым нужно заведомо
 * пустое, передают собственный storePath — иначе состояние хранилища
 * утекает между шагами одного каталога.
 */
function makeDirIo(
  dir: string,
  overrides: Partial<XlsxIo> = {},
  storePath = "config/config.json",
): TestIo {
  const real = makeDenoIo(`${dir}/${storePath}`);
  return makeTestIo({
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
    fixture: "get-tsv.txt.b64",
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
    for (const gc of GOLDEN) {
      await t.step(gc.args.join(" "), async () => {
        const expected = (await fixtureText(gc.fixture))
          .replaceAll(SNAPSHOT_DIR, dir);
        const first = makeDirIo(dir);
        const code = await runXlsx(gc.args, first.io);
        assertEquals(code, gc.exit, first.stderr());
        const got = gc.stream === "stderr" ? first.stderr() : first.stdout();
        assertEquals(got, expected);
        // Инвариант спеки: повторный вызов побитово идентичен.
        const second = makeDirIo(dir);
        await runXlsx(gc.args, second.io);
        const again = gc.stream === "stderr"
          ? second.stderr()
          : second.stdout();
        assertEquals(again, got);
      });
    }
  });
});

Deno.test("get: конфликты флагов и режимов — до открытия файла", async (t) => {
  await t.step("--json/--raw/--tsv", async () => {
    const { io, stderr } = makeTestIo({});
    const code = await runXlsx(
      ["get", "-f", "нет-такого.xlsx", "S!A1", "--json", "--raw"],
      io,
    );
    assertEquals(code, 2);
    assertEquals(
      stderr(),
      "mpu xlsx: only one of --json / --raw / --tsv can be set\n",
    );
  });
  await t.step("--render вне both|values|formulas", async () => {
    const { io, stderr } = makeTestIo({});
    const code = await runXlsx(
      ["get", "-f", "x.xlsx", "S!A1", "--render", "wat"],
      io,
    );
    assertEquals(code, 2);
    assertStringIncludes(stderr(), `invalid --render value "wat"`);
  });
  await t.step("диапазон без листа и без --sheet", async () => {
    const { io, stderr } = makeTestIo({});
    const code = await runXlsx(["get", "-f", "x.xlsx", "A1:B2"], io);
    assertEquals(code, 2);
    assertStringIncludes(stderr(), "--sheet");
  });
  await t.step("ls: -l и --json", async () => {
    const { io, stderr } = makeTestIo({});
    const code = await runXlsx(["ls", "-f", "x.xlsx", "-l", "--json"], io);
    assertEquals(code, 2);
    assertEquals(
      stderr(),
      "mpu xlsx: only one of --long / --json can be set\n",
    );
  });
});

Deno.test("get: --sheet, --from, stdin, дедупликация", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("--sheet: префикс и весь лист без диапазонов", async () => {
      const a = makeDirIo(dir);
      const codeA = await runXlsx(
        ["get", "-f", "sample.xlsx", "B2", "--sheet", "Данные", "--raw"],
        a.io,
      );
      assertEquals([codeA, a.stdout()], [0, "42"]);
      const b = makeDirIo(dir);
      const codeB = await runXlsx(
        ["get", "-f", "sample.xlsx", "--sheet", "Пустой"],
        b.io,
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
      const { io, stdout } = makeDirIo(dir);
      const code = await runXlsx(
        ["get", "-f", "sample.xlsx", "Данные!B2", "--from", ranges, "--tsv"],
        io,
      );
      assertEquals(code, 0);
      assertEquals(
        stdout(),
        "range\tvalue\tformula\nДанные!B2\t42\t\nДанные!A1\tтовар\t\n",
      );
    });
    await t.step("плотный прямоугольник: пустые ячейки как null", async () => {
      const { io, stdout } = makeDirIo(dir);
      const code = await runXlsx(
        ["get", "-f", "sample.xlsx", "Данные!A4:C4"],
        io,
      );
      assertEquals(code, 0);
      assertEquals(
        stdout(),
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
      const { io, stdout } = makeDirIo(dir);
      const code = await runXlsx(
        [
          "get",
          "-f",
          "sample.xlsx",
          "--from",
          `${dir}/r1.txt`,
          "--from",
          `${dir}/r2.txt`,
          "--tsv",
        ],
        io,
      );
      assertEquals(code, 0);
      assertEquals(
        stdout(),
        "range\tvalue\tformula\nДанные!B2\t42\t\nДанные!A1\tтовар\t\n",
      );
    });
    await t.step("--from с несуществующим файлом — exit 1", async () => {
      const { io, stderr } = makeDirIo(dir);
      const code = await runXlsx(
        ["get", "-f", "sample.xlsx", "--from", "нет.txt"],
        io,
      );
      assertEquals(code, 1);
      assertEquals(
        stderr(),
        `mpu xlsx: ranges file not found: "нет.txt"\n`,
      );
    });
    await t.step("дедупликация именно после префиксации --sheet", async () => {
      const { io, stdout } = makeDirIo(dir);
      const args = ["B2", "Данные!B2", "-n", "Данные", "--tsv"];
      const code = await runXlsx(
        ["get", "-f", "sample.xlsx", ...args],
        io,
      );
      assertEquals(code, 0);
      assertEquals(stdout(), "range\tvalue\tformula\nДанные!B2\t42\t\n");
    });
    await t.step("битое хранилище конфига — exit 1", async () => {
      await Deno.mkdir(`${dir}/corrupt`, { recursive: true });
      await Deno.writeTextFile(`${dir}/corrupt/config.json`, "{oops");
      const { io, stderr } = makeDirIo(dir, {}, "corrupt/config.json");
      const code = await runXlsx(["alias", "ls"], io);
      assertEquals(code, 1);
      assertStringIncludes(stderr(), "mpu xlsx: corrupt config store");
    });
    await t.step("--from - читает stdin", async () => {
      const { io, stdout } = makeDirIo(dir, {
        readTextStdin: () => Promise.resolve("Данные!C2\n"),
      });
      const code = await runXlsx(
        ["get", "-f", "sample.xlsx", "--from", "-", "--raw"],
        io,
      );
      assertEquals([code, stdout()], [0, "True"]);
    });
    await t.step("--render values/formulas в json", async () => {
      const v = makeDirIo(dir);
      await runXlsx(
        ["get", "-f", "sample.xlsx", "Данные!A4", "--render", "values"],
        v.io,
      );
      assertStringIncludes(v.stdout(), `"value": 84`);
      assertEquals(v.stdout().includes("formula"), false);
      const f = makeDirIo(dir);
      await runXlsx(
        ["get", "-f", "sample.xlsx", "Данные!A4:A5", "--render", "formulas"],
        f.io,
      );
      assertStringIncludes(f.stdout(), `"formula": "=B2*2"`);
      assertEquals(f.stdout().includes(`"value"`), false);
    });
  });
});

Deno.test("резолв пути: env и config, файл не найден", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("env MPU_XLSX", async () => {
      const { io, stdout } = makeDirIo(dir, {
        env: (name) => name === "MPU_XLSX" ? `${dir}/sample.xlsx` : undefined,
      });
      assertEquals(await runXlsx(["ls"], io), 0);
      assertEquals(stdout(), "Данные\nПустой\n");
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
      const { io, stdout } = makeDirIo(dir);
      assertEquals(await runXlsx(["ls"], io), 0);
      assertEquals(stdout(), "Данные\nПустой\n");
    });
    await t.step("путь не задан — текст спеки", async () => {
      // Собственное (пустое) хранилище: шаг выше записал xlsx.default.
      const { io, stderr } = makeDirIo(dir, {}, "empty/config.json");
      const code = await runXlsx(["ls"], io);
      assertEquals(code, 2);
      assertEquals(
        stderr(),
        "mpu xlsx: путь к .xlsx не задан. Проверены (по порядку): " +
          "--file/-f, env MPU_XLSX, config xlsx.default; попробуй: " +
          "--file <путь>, export MPU_XLSX=<путь> " +
          "или задай config xlsx.default\n",
      );
    });
    await t.step("файл не найден — абсолютный путь в ошибке", async () => {
      const { io, stderr } = makeDirIo(dir);
      const code = await runXlsx(["ls", "-f", "нет.xlsx"], io);
      assertEquals(code, 1);
      assertEquals(stderr(), `mpu xlsx: file not found: "${dir}/нет.xlsx"\n`);
    });
  });
});

Deno.test("alias: add/ls/rm, права хранилища, использование", async (t) => {
  await withSampleDir(async (dir) => {
    const run = async (...args: string[]) => {
      const cap = makeDirIo(dir);
      const code = await runXlsx(args, cap.io);
      return { code, out: cap.stdout(), err: cap.stderr() };
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
    await t.step("ls и ls --json", async () => {
      await run("alias", "add", "b", "second.xlsx");
      const plain = await run("alias", "ls");
      assertEquals(plain.out, `b\tsecond.xlsx\nprobe\t${dir}/sample.xlsx\n`);
      const json = await run("alias", "ls", "--json");
      assertEquals(
        JSON.parse(json.out),
        { b: "second.xlsx", probe: `${dir}/sample.xlsx` },
      );
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
        [["alias", "add", "a", "b", "c"], "ожидает два аргумента"],
        [["alias", "wat"], `unknown alias subcommand "wat"`],
      ];
      for (const [args, snippet] of cases) {
        // makeTestIo: любое обращение к файлам/хранилищу — падение.
        const bad = makeTestIo({
          readConfigStore: () => {
            throw new Error("store must not be read");
          },
        });
        const code = await runXlsx([...args], bad.io);
        assertEquals(code, 2, args.join(" "));
        assertStringIncludes(bad.stderr(), snippet);
      }
    });
    await t.step("похожее на алиас, но не алиас — молча путь", async () => {
      const miss = await run("get", "-f", "ghost", "Данные!A1");
      assertEquals(miss.code, 1);
      assertEquals(miss.err, `mpu xlsx: file not found: "${dir}/ghost"\n`);
    });
  });
});

Deno.test("resolve: json-форма и exit-коды", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("--json при нерезолве — exit 0, resolved null", async () => {
      const { io, stdout } = makeDirIo(dir);
      const code = await runXlsx(["resolve", "--json"], io);
      assertEquals(code, 0);
      const parsed = JSON.parse(stdout());
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
      const { io, stdout } = makeDirIo(dir);
      await runXlsx(["resolve", "-f", "sample.xlsx", "--json"], io);
      const parsed = JSON.parse(stdout());
      assertEquals(parsed.resolved, {
        path: `${dir}/sample.xlsx`,
        source: "flag",
      });
    });
    await t.step("без --json и без пути — exit 2", async () => {
      const { io, stdout, stderr } = makeDirIo(dir);
      const code = await runXlsx(["resolve"], io);
      assertEquals(code, 2);
      assertStringIncludes(stdout(), "--file/-f: (пусто)");
      assertStringIncludes(stderr(), "путь к .xlsx не задан");
    });
    await t.step("без --json с путём — exit 0 и победитель", async () => {
      const { io, stdout } = makeDirIo(dir);
      const code = await runXlsx(["resolve", "-f", "sample.xlsx"], io);
      assertEquals(code, 0);
      assertStringIncludes(stdout(), "← используется");
      assertStringIncludes(stdout(), `путь: ${dir}/sample.xlsx`);
    });
  });
});

Deno.test("open: --print и отсутствие открывателя", async (t) => {
  await withSampleDir(async (dir) => {
    await t.step("--print печатает путь, открыватель не зовётся", async () => {
      const { io, stdout } = makeDirIo(dir);
      const code = await runXlsx(
        ["open", "-f", "sample.xlsx", "--print"],
        io,
      );
      assertEquals([code, stdout()], [0, `${dir}/sample.xlsx\n`]);
    });
    await t.step("первый доступный открыватель", async () => {
      const calls: string[] = [];
      const { io } = makeDirIo(dir, {
        launchOpener: (cmd, target) => {
          calls.push(`${cmd} ${target}`);
          return cmd === "open";
        },
      });
      const code = await runXlsx(["open", "-f", "sample.xlsx"], io);
      assertEquals(code, 0);
      assertEquals(calls, [
        `xdg-open ${dir}/sample.xlsx`,
        `open ${dir}/sample.xlsx`,
      ]);
    });
    await t.step("нет открывателя — exit 1 и подсказка --print", async () => {
      const { io, stderr } = makeDirIo(dir, { launchOpener: () => false });
      const code = await runXlsx(["open", "-f", "sample.xlsx"], io);
      assertEquals(code, 1);
      assertEquals(
        stderr(),
        "mpu xlsx: no opener found (xdg-open, open); попробуй: --print\n",
      );
    });
  });
});

Deno.test("справка: каждый уровень, без io, bare — exit 2", async (t) => {
  await t.step("bare и --help", async () => {
    const bare = makeTestIo({});
    assertEquals(await runXlsx([], bare.io), 2);
    const help = makeTestIo({});
    assertEquals(await runXlsx(["--help"], help.io), 0);
    assertEquals(bare.stdout(), help.stdout());
    assertMatch(help.stdout(), /Подкоманды:/);
  });
  await t.step("листовые --help из индекса, без обращений к io", async () => {
    const index = makeTestIo({});
    await runXlsx(["--help"], index.io);
    const names = [...index.stdout().matchAll(/^ {2}(\S+)/gm)]
      .map((m) => m[1]);
    assertEquals(names.length > 0, true, "индекс не распарсился");
    for (const name of names) {
      const leaf = makeTestIo({});
      const code = await runXlsx([name, "--help"], leaf.io);
      assertEquals(code, 0, `--help не работает у «${name}»`);
      assertEquals(leaf.stdout().length > 0, true, `пустая справка «${name}»`);
    }
  });
  await t.step("уровни alias: bare exit 2, листы exit 0", async () => {
    const bare = makeTestIo({});
    assertEquals(await runXlsx(["alias"], bare.io), 2);
    for (const sub of ["add", "ls", "rm"]) {
      const leaf = makeTestIo({});
      const code = await runXlsx(["alias", sub, "--help"], leaf.io);
      assertEquals(code, 0, `alias ${sub} --help`);
      assertEquals(leaf.stdout().length > 0, true);
    }
  });
  await t.step("неизвестная подкоманда — exit 2", async () => {
    const { io, stderr } = makeTestIo({});
    assertEquals(await runXlsx(["wat"], io), 2);
    assertStringIncludes(stderr(), `unknown subcommand "wat"`);
  });
});
