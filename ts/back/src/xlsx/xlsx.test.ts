import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../entrypoint/mod.ts";
import { type CommandIo, DomainError, type EnvFile } from "../command/mod.ts";
import { setConfigValue } from "../config/mod.ts";
import { makeDenoIo } from "../runtime/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { xlsxCommands } from "./mod.ts";

/** Заглушка env-файла: значения из карты, `require`/`set` не ожидаются. */
function envFileFake(values: Readonly<Record<string, string>>): EnvFile {
  return {
    get: (name) => values[name],
    require: () => {
      throw new Error("envFile.require must not be touched");
    },
    set: () => {
      throw new Error("envFile.set must not be touched");
    },
    values: () => ({ ...values }),
  };
}

/** Плейсхолдер снапшот-каталога в golden-эталонах спеки. */
const SNAPSHOT_DIR = "{{SNAPSHOT_DIR}}";

const testdataUrl = (name: string) =>
  new URL(`testdata/${name}`, import.meta.url);

async function fixtureText(name: string): Promise<string> {
  return await readFile(testdataUrl(name), "utf8");
}

async function fixtureB64(name: string): Promise<Uint8Array> {
  const b64 = await readFile(testdataUrl(name), "utf8");
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
  const io = makeFakeIo(overrides);
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
 * настоящего io), cwd в dir и захватом вывода в буферы. Предпочтения и
 * алиасы — настоящая кэш-БД в dir/config; шаги, которым нужна заведомо
 * пустая, передают собственный dbPath — иначе состояние базы утекает
 * между шагами одного каталога.
 */
function makeDirCli(
  dir: string,
  overrides: Partial<CommandIo> = {},
  dbPath = "config/mpu.db",
): TestCli {
  const real = makeDenoIo(`${dir}/config`);
  return makeTestCli({
    readFile: real.readFile,
    readTextFile: real.readTextFile,
    openCacheDb: () => openCacheDb(`${dir}/${dbPath}`),
    env: () => undefined,
    envFile: envFileFake({}),
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
  const { dir, close } = await openSampleDir();
  try {
    await fn(dir);
  } finally {
    await close();
  }
}

/**
 * Тот же каталог на весь `describe`: создаётся в `beforeAll`, `close` — в
 * `afterAll`.
 */
async function openSampleDir(): Promise<{
  dir: string;
  close: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const close = () => rm(dir, { recursive: true });
  try {
    await writeFile(`${dir}/sample.xlsx`, await fixtureB64("sample.xlsx.b64"));
    await copyFile(testdataUrl("broken.xlsx"), `${dir}/broken.xlsx`);
  } catch (err) {
    await close();
    throw err;
  }
  return { dir, close };
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

describe("golden: таблица эталонов спеки, байт-в-байт", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, close } = await openSampleDir());
  });
  afterAll(() => close());

  for (const goldenCase of GOLDEN) {
    it(goldenCase.args.join(" "), async () => {
      // Плейсхолдер эталона подставляется тестом: снапшот-каталог —
      // свойство прогона, а не фикстуры (контракт спеки xlsx.md).
      const expected = (await fixtureText(goldenCase.fixture)).replaceAll(
        SNAPSHOT_DIR,
        dir,
      );
      const first = makeDirCli(dir);
      const code = await first.run(...goldenCase.args);
      expect(code, first.stderr()).toStrictEqual(goldenCase.exit);
      const got =
        goldenCase.stream === "stderr" ? first.stderr() : first.stdout();
      expect(got).toStrictEqual(expected);
      // Инвариант спеки: повторный вызов побитово идентичен.
      const second = makeDirCli(dir);
      await second.run(...goldenCase.args);
      const again =
        goldenCase.stream === "stderr" ? second.stderr() : second.stdout();
      expect(again).toStrictEqual(got);
    });
  }
});

describe("get: конфликты флагов и режимов — до открытия файла", () => {
  it("--raw и --tsv вместе", async () => {
    const cli = makeTestCli();
    const code = await cli.run(
      "get",
      "-f",
      "нет-такого.xlsx",
      "S!A1",
      "--raw",
      "--tsv",
    );
    expect(code).toBe(2);
    expect(cli.stderr()).toStrictEqual(
      "mpu xlsx: only one format: raw or tsv; " +
        "попробуй: mpu xlsx get --help\n",
    );
  });
  it("--render вне both|values|formulas", async () => {
    const cli = makeTestCli();
    const code = await cli.run(
      "get",
      "-f",
      "x.xlsx",
      "S!A1",
      "--render",
      "wat",
    );
    expect(code).toBe(2);
    expect(cli.stderr()).toContain(`invalid render: value "wat"`);
  });
  it("диапазон без листа и без --sheet", async () => {
    const cli = makeTestCli();
    const code = await cli.run("get", "-f", "x.xlsx", "A1:B2");
    expect(code).toBe(2);
    expect(cli.stderr()).toContain("--sheet");
  });
});

describe("get: --sheet, --from, stdin, дедупликация", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, close } = await openSampleDir());
  });
  afterAll(() => close());

  it("--sheet: префикс и весь лист без диапазонов", async () => {
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
    expect([codeA, a.stdout()]).toStrictEqual([0, "42"]);
    const b = makeDirCli(dir);
    const codeB = await b.run("get", "-f", "sample.xlsx", "--sheet", "Пустой");
    expect(codeB).toBe(0);
    expect(b.stdout()).toContain(`"cells": []`);
  });
  it("--from файл + аргументы, дубликаты убраны", async () => {
    const ranges = `${dir}/ranges.txt`;
    await writeFile(ranges, "# комментарий\n\nДанные!B2\nДанные!A1\n");
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
    expect(code).toBe(0);
    expect(cli.stdout()).toBe(
      "range\tvalue\tformula\nДанные!B2\t42\t\nДанные!A1\tтовар\t\n",
    );
  });
  it("плотный прямоугольник: пустые ячейки как null", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("get", "-f", "sample.xlsx", "Данные!A4:C4");
    expect(code).toBe(0);
    expect(cli.stdout()).toStrictEqual(`{
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
}`);
  });
  it("--from повторяется, порядок файлов сохранён", async () => {
    await writeFile(`${dir}/r1.txt`, "Данные!B2\n");
    await writeFile(`${dir}/r2.txt`, "Данные!A1\n");
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
    expect(code).toBe(0);
    expect(cli.stdout()).toBe(
      "range\tvalue\tformula\nДанные!B2\t42\t\nДанные!A1\tтовар\t\n",
    );
  });
  it("--from с несуществующим файлом — exit 1", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("get", "-f", "sample.xlsx", "--from", "нет.txt");
    expect(code).toBe(1);
    expect(cli.stderr()).toBe(`mpu xlsx: ranges file not found: "нет.txt"\n`);
  });
  it("дедупликация именно после префиксации --sheet", async () => {
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
    expect(code).toBe(0);
    expect(cli.stdout()).toBe("range\tvalue\tformula\nДанные!B2\t42\t\n");
  });
  it("--from - читает stdin", async () => {
    const cli = makeDirCli(dir, {
      readStdin: () => Promise.resolve(new TextEncoder().encode("Данные!C2\n")),
    });
    const code = await cli.run(
      "get",
      "-f",
      "sample.xlsx",
      "--from",
      "-",
      "--raw",
    );
    expect([code, cli.stdout()]).toStrictEqual([0, "True"]);
  });
  it("--render values/formulas в результате", async () => {
    const values = makeDirCli(dir);
    await values.run(
      "get",
      "-f",
      "sample.xlsx",
      "Данные!A4",
      "--render",
      "values",
    );
    expect(values.stdout()).toContain(`"value": 84`);
    expect(values.stdout().includes("formula")).toBe(false);
    const formulas = makeDirCli(dir);
    await formulas.run(
      "get",
      "-f",
      "sample.xlsx",
      "Данные!A4:A5",
      "--render",
      "formulas",
    );
    expect(formulas.stdout()).toContain(`"formula": "=B2*2"`);
    expect(formulas.stdout().includes(`"value"`)).toBe(false);
  });
});

describe("резолв пути: env и config, файл не найден", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, close } = await openSampleDir());
  });
  afterAll(() => close());

  it("MPU_XLSX (env-файл)", async () => {
    const cli = makeDirCli(dir, {
      envFile: envFileFake({ MPU_XLSX: `${dir}/sample.xlsx` }),
    });
    expect(await cli.run("ls")).toBe(0);
    expect(cli.stdout()).toBe("Данные\nПустой\n");
  });
  it("config xlsx.default", async () => {
    {
      using db = openCacheDb(`${dir}/config/mpu.db`);
      setConfigValue(db, "xlsx.default", `${dir}/sample.xlsx`);
    }
    const cli = makeDirCli(dir);
    expect(await cli.run("ls")).toBe(0);
    expect(cli.stdout()).toBe("Данные\nПустой\n");
  });
  it("путь не задан — текст спеки", async () => {
    // Собственная (пустая) БД: шаг выше записал xlsx.default.
    const cli = makeDirCli(dir, {}, "empty/mpu.db");
    const code = await cli.run("ls");
    expect(code).toBe(2);
    expect(cli.stderr()).toStrictEqual(
      "mpu xlsx: путь к .xlsx не задан. Проверены (по порядку): " +
        "--file/-f, MPU_XLSX (env-файл), config xlsx.default; " +
        "попробуй: --file <путь>, MPU_XLSX=<путь> в ~/.config/mpu/.env " +
        "или задай config xlsx.default\n",
    );
  });
  it("файл не найден — абсолютный путь в ошибке", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("ls", "-f", "нет.xlsx");
    expect(code).toBe(1);
    expect(cli.stderr()).toStrictEqual(
      `mpu xlsx: file not found: "${dir}/нет.xlsx"\n`,
    );
  });
});

it("без HOME путь по флагу всё равно резолвится", async () => {
  await withSampleDir(async (dir) => {
    // Хранилища предпочтений нет вовсе (пути к БД не из чего собрать):
    // вызов, целиком определённый флагом, обязан работать и в cron, и
    // в контейнере — иначе переезд предпочтений в БД сломал бы то,
    // что к предпочтениям отношения не имеет.
    const cli = makeDirCli(dir, {
      openCacheDb: () => {
        throw new DomainError("путь к кэш-БД не определён: HOME не задан");
      },
    });
    expect(
      await cli.run("get", "-f", `${dir}/sample.xlsx`, "Данные!B2", "--raw"),
    ).toBe(0);
    expect(cli.stdout()).toBe("42");
  });
});

describe("alias: add/ls/rm, права хранилища, использование", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, close } = await openSampleDir());
  });
  const run = async (...args: string[]) => {
    const cli = makeDirCli(dir);
    const code = await cli.run(...args);
    return { code, out: cli.stdout(), err: cli.stderr() };
  };
  afterAll(() => close());

  it("add + использование алиаса", async () => {
    const added = await run("alias", "add", "probe", `${dir}/sample.xlsx`);
    expect([added.code, added.out]).toStrictEqual([0, ""]);
    const used = await run("get", "-f", "probe", "Данные!B2", "--raw");
    expect([used.code, used.out]).toStrictEqual([0, "42"]);
  });
  it("права файла хранилища 0600 и при перезаписи", async () => {
    // Хранилище алиасов — файл кэш-БД (`platform/store.md`): права
    // выставляет открытие, а приводит к 0600 bootstrap записи.
    const path = `${dir}/config/mpu.db`;
    // mode на POSIX всегда есть; тесты не для Windows.
    const created = await stat(path);
    expect(created.mode & 0o777, "при создании").toBe(0o600);
    await chmod(path, 0o644);
    expect((await run("alias", "add", "perm", "x.xlsx")).code).toBe(0);
    const rewritten = await stat(path);
    expect(rewritten.mode & 0o777, "после перезаписи").toBe(0o600);
    expect((await run("alias", "rm", "perm")).code).toBe(0);
  });
  it("ls текстом и как структурный результат", async () => {
    await run("alias", "add", "b", "second.xlsx");
    const plain = await run("alias", "ls");
    expect(plain.out).toStrictEqual(
      `b\tsecond.xlsx\nprobe\t${dir}/sample.xlsx\n`,
    );
    const json = await run("alias", "ls", "--json");
    expect(JSON.parse(json.out)).toStrictEqual({
      aliases: [
        { name: "b", path: "second.xlsx" },
        { name: "probe", path: `${dir}/sample.xlsx` },
      ],
    });
  });
  it("rm идемпотентен", async () => {
    expect((await run("alias", "rm", "b")).code).toBe(0);
    expect((await run("alias", "rm", "b")).code).toBe(0);
    const rest = await run("alias", "ls");
    expect(rest.out).toStrictEqual(`probe\t${dir}/sample.xlsx\n`);
  });
  it("невалидное имя и пустой путь — exit 2", async () => {
    const bad = await run("alias", "add", "кириллица", "x.xlsx");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("invalid alias name");
    const empty = await run("alias", "add", "ok", "");
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("alias path must not be empty");
  });
  it("ошибки аргументов: exit 2 без записи", async () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["alias", "rm"], "ожидает name:"],
      [["alias", "add", "x"], "ожидает name: и path:"],
      [["alias", "add", "a", "b", "c"], `unexpected argument "c"`],
      [["alias", "wat"], "No such command 'xlsx alias wat'."],
    ];
    for (const [args, snippet] of cases) {
      // Хранилище бросает: разбор аргументов обязан упасть до него.
      const cli = makeTestCli({
        openCacheDb: () => {
          throw new Error("store must not be read");
        },
      });
      const code = await cli.run(...args);
      expect(code, args.join(" ")).toBe(2);
      expect(cli.stderr()).toContain(snippet);
    }
  });
  it("похожее на алиас, но не алиас — молча путь", async () => {
    const miss = await run("get", "-f", "ghost", "Данные!A1");
    expect(miss.code).toBe(1);
    expect(miss.err).toStrictEqual(
      `mpu xlsx: file not found: "${dir}/ghost"\n`,
    );
  });
});

describe("resolve: структурный результат и exit-коды", () => {
  // Код отдаёт результат, а не форма (`platform/line-grammar.md` [D.6]).
  let dir: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, close } = await openSampleDir());
  });
  afterAll(() => close());

  it("--json при нерезолве — exit 2, resolved null", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("resolve", "--json");
    expect(code).toBe(2);
    const parsed = JSON.parse(cli.stdout());
    expect(parsed.resolved).toStrictEqual(null);
    expect(parsed.checked.length).toBe(3);
    expect(parsed.checked[0]).toStrictEqual({
      source: "flag",
      label: "--file/-f",
      value: null,
      used: false,
    });
  });
  it("--json с флагом — источник и путь", async () => {
    const cli = makeDirCli(dir);
    await cli.run("resolve", "-f", "sample.xlsx", "--json");
    const parsed = JSON.parse(cli.stdout());
    expect(parsed.resolved).toStrictEqual({
      path: `${dir}/sample.xlsx`,
      source: "flag",
    });
  });
  it("текстовая форма без пути — exit 2", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("resolve");
    expect(code).toBe(2);
    // Диагностика печатается и при неуспехе: она и есть результат.
    expect(cli.stdout()).toContain("--file/-f: (пусто)");
  });
  it("текстовая форма с путём — exit 0 и победитель", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("resolve", "-f", "sample.xlsx");
    expect(code).toBe(0);
    expect(cli.stdout()).toContain("← используется");
    expect(cli.stdout()).toContain(`путь: ${dir}/sample.xlsx`);
  });
});

describe("open: --print и отсутствие открывателя", () => {
  let dir: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, close } = await openSampleDir());
  });
  afterAll(() => close());

  it("--print печатает путь, открыватель не зовётся", async () => {
    const cli = makeDirCli(dir);
    const code = await cli.run("open", "-f", "sample.xlsx", "--print");
    expect([code, cli.stdout()]).toStrictEqual([0, `${dir}/sample.xlsx\n`]);
  });
  it("первый доступный открыватель", async () => {
    const calls: string[] = [];
    const cli = makeDirCli(dir, {
      launchOpener: (cmd, target) => {
        calls.push(`${cmd} ${target}`);
        return cmd === "open";
      },
    });
    const code = await cli.run("open", "-f", "sample.xlsx");
    expect(code).toBe(0);
    expect(calls).toStrictEqual([
      `xdg-open ${dir}/sample.xlsx`,
      `open ${dir}/sample.xlsx`,
    ]);
  });
  it("нет открывателя — exit 1 и подсказка --print", async () => {
    const cli = makeDirCli(dir, { launchOpener: () => false });
    const code = await cli.run("open", "-f", "sample.xlsx");
    expect(code).toBe(1);
    expect(cli.stderr()).toBe(
      "mpu xlsx: no opener found (xdg-open, open); попробуй: print\n",
    );
  });
});

it("политики подкоманд — поимённо по таблице спеки", () => {
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
  expect(actual).toStrictEqual(expected);
});

describe("справка: каждый уровень, без io, bare — exit 2", () => {
  it("bare и --help", async () => {
    const bare = makeTestCli();
    expect(await bare.run()).toBe(2);
    const help = makeTestCli();
    expect(await help.run("--help")).toBe(0);
    expect(bare.stdout()).toStrictEqual(help.stdout());
    expect(help.stdout()).toMatch(/Подкоманды:/);
  });
  it("листовые --help из индекса, без обращений к io", async () => {
    const index = makeTestCli();
    await index.run("--help");
    const names = [...index.stdout().matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]);
    expect(names.length > 0, "индекс не распарсился").toBe(true);
    for (const name of names) {
      const leaf = makeTestCli();
      const code = await leaf.run(name, "--help");
      expect(code, `--help не работает у «${name}»`).toBe(0);
      expect(leaf.stdout().length > 0, `пустая справка «${name}»`).toBe(true);
    }
  });
  it("уровни alias: bare exit 2, листы exit 0", async () => {
    const bare = makeTestCli();
    expect(await bare.run("alias")).toBe(2);
    for (const sub of ["add", "ls", "rm"]) {
      const leaf = makeTestCli();
      const code = await leaf.run("alias", sub, "--help");
      expect(code, `alias ${sub} --help`).toBe(0);
      expect(leaf.stdout().length > 0).toBe(true);
    }
  });
  it("неизвестная подкоманда — exit 2", async () => {
    const cli = makeTestCli();
    expect(await cli.run("wat")).toBe(2);
    expect(cli.stderr()).toBe(
      "No such command 'xlsx wat'.\nTry 'mpu -h' for help.\n",
    );
  });
});
