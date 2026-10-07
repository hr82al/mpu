/**
 * Программа из файла `run:` (`platform/program-input.md`, порция 170b):
 * «Файл и параметры», «Байты файла», «Секрет», «`ask` и правила»,
 * «Справка, дополнение и MCP». Стенд — `ask-composite.md`: `kiten ls`
 * allow, `kiten comment` ask, `sql` deny. Домашний каталог — временный:
 * `<tmp>/u`, каталог вызова `<tmp>/u/w`, `XDG_CONFIG_HOME=<tmp>/u/xdg`;
 * в тексте ожиданий он пишется `/home/u`. Файлы секретов — синтетические.
 */

import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { type CommandIo, DomainError } from "../command/mod.ts";
import { makeInvokeLog } from "../invokelog/mod.ts";
import { ASK, DENY, Human, NOBODY, RuleBook, RulePath } from "../policy/mod.ts";
import { type ChannelOf, type ProgramFiles, programFiles } from "./mod.ts";
import { osError } from "../oserror/mod.ts";
import { within } from "../backend/testback.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { type Ran, runOnStand, withStand } from "./testprogram.ts";

const BOM = [0xef, 0xbb, 0xbf];

/** Токен в каталоге настроек: его не должно быть ни в одном выводе. */
const SECRET = "s3cr3t";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Домашний каталог стенда: пути и запись файлов в нём. */
interface Home {
  /** Настоящий путь того, что в ожиданиях пишется `/home/u`. */
  readonly root: string;
  /** Текст с настоящим путём вместо `/home/u`. */
  real(text: string): string;
  write(path: string, content: string | Uint8Array): Promise<void>;
}

/** Канал (FIFO) по пути; ненулевой код `mkfifo` — отказ. */
function mkfifo(path: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile("mkfifo", [path], (err) =>
      err === null ? resolve() : reject(err),
    ),
  );
}

/** Дом стенда, открытый на набор шагов; `close` его убирает. */
interface OpenHome extends Home {
  close(): Promise<void>;
}

/** Домашний каталог стенда с секретами на местах; `close` его убирает. */
async function openHome(): Promise<OpenHome> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const root = `${dir}/u`;
  const home: Home = {
    root,
    real: (text) => text.replaceAll("/home/u", root),
    write: async (path, content) => {
      const full = home.real(path);
      await mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      const data = typeof content === "string" ? bytes(content) : content;
      await writeFile(full, data);
    },
  };
  const close = async () => {
    await chmod(root, 0o755).catch(() => {});
    await rm(dir, { recursive: true });
  };
  try {
    await mkdir(`${root}/w`, { recursive: true });
    await home.write("/home/u/.config/mpu/token", SECRET);
    await home.write("/home/u/.config/mpu/mcp-token", SECRET);
    await home.write("/home/u/.ssh/id_ed25519", SECRET);
  } catch (err) {
    await close();
    throw err;
  }
  return { ...home, close };
}

/** Временный `/home/u` с каталогом вызова `w` и токеном в настройках. */
async function withHome(fn: (home: Home) => Promise<void>) {
  const home = await openHome();
  try {
    await fn(home);
  } finally {
    await home.close();
  }
}

/** Как строку зовут на стенде. */
interface Call {
  /** Ввод из пайпа байтами; нет — stdin терминал. */
  readonly stdin?: Uint8Array;
  /** Ответы человека по очереди. */
  readonly answers?: readonly string[];
  /** Человека нет (агент без elicitation). */
  readonly nobody?: boolean;
  /** Каталог строки; нет — `/home/u/w`. */
  readonly cwd?: string;
  /** Файл журнала вызовов: запись строки — в него. */
  readonly log?: string;
  /** Ключей бота нет: `telegram log` падает конфигурацией, до сети. */
  readonly botless?: boolean;
  /** Чтение файла программы отказывает этой ошибкой ОС. */
  readonly readFails?: Error;
}

/** env-файл без ключей: любое требование — отказ конфигурации. */
const BOTLESS: Partial<CommandIo> = {
  envFile: {
    get: () => undefined,
    values: () => ({}),
    require: (name: string) => {
      throw new DomainError(`env: в файле нет ключа ${name}`);
    },
    set: () => Promise.resolve(),
  },
};

/** Итог строки, сколько раз читали ввод и созданные комментарии. */
interface Called extends Ran {
  readonly reads: number;
  readonly posted: readonly string[];
  readonly asked: number;
}

function humanAt(answers: readonly string[]): ChannelOf {
  const queue = [...answers];
  return (_io, output) =>
    new Human(output.stderr, () => Promise.resolve(queue.shift()));
}

function inputOf(given: Call, read: () => void): Partial<CommandIo> {
  const stdin = given.stdin;
  if (stdin === undefined) {
    return {
      readStdin: () => {
        read();
        return Promise.resolve(new Uint8Array());
      },
    };
  }
  return {
    stdinIsTerminal: () => false,
    readStdin: () => {
      read();
      return Promise.resolve(stdin.slice());
    },
  };
}

/** Строка `words` на стенде в домашнем каталоге `home`. */
/** Файлы программ, у которых чтение отказывает `fails`; без неё — как есть. */
function refusingRead(files: ProgramFiles, fails?: Error): ProgramFiles {
  if (fails === undefined) return files;
  return { ...files, read: () => Promise.reject(fails) };
}

function run(
  home: Home,
  words: readonly string[],
  given: Call = {},
): Promise<Called> {
  let result: Called | undefined;
  const env: Record<string, string> = {
    HOME: home.root,
    XDG_CONFIG_HOME: `${home.root}/xdg`,
  };
  return withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      {
        using book = RuleBook.open(file, []);
        book.set(RulePath.parse("kiten comment"), ASK);
        book.set(RulePath.parse("sql"), DENY);
      }
      let reads = 0;
      const log =
        given.log === undefined
          ? undefined
          : makeInvokeLog({
              env: { get: () => undefined },
              defaultFile: given.log,
              pid: 777,
              now: () => new Date(),
            });
      const ran = await runOnStand(file, words, stand, {
        io: {
          ...inputOf(given, () => reads++),
          stderrIsTerminal: () => true,
          cwd: () => home.real(given.cwd ?? "/home/u/w"),
          ...(given.botless ? BOTLESS : {}),
        },
        channel: given.nobody ? () => NOBODY : humanAt(given.answers ?? []),
        files: refusingRead(
          programFiles((name) => env[name]),
          given.readFails,
        ),
        log,
      });
      result = {
        ...ran,
        stderr: ran.stderr.replaceAll(home.root, "/home/u"),
        refusals: ran.refusals.map((one) => ({
          ...one,
          text: one.text.replaceAll(home.root, "/home/u"),
        })),
        reads,
        posted: stand.posted(),
        asked: stand.asked(),
      };
    }),
  ).then(() => {
    if (result === undefined) throw new Error("стенд не прогнал строку");
    return result;
  });
}

/** Прогон: stdout, stderr и код одним значением — для сравнения. */
const seen = (got: Called): readonly [string, string, number] => [
  got.stdout,
  got.stderr,
  got.exit,
];

describe("run: файл и параметры — значение ключа вызова", () => {
  const cases: readonly (readonly [string, readonly string[], Call, string])[] =
    [
      ["col: review", ["col:", "review"], {}, "review\n"],
      ["--col review", ["--col", "review"], {}, "review\n"],
      ["лишний ключ", ["col:", "review", "extra:", "1"], {}, "review\n"],
      [
        "^…^ из слов",
        ["col:", "^готово", "к", "ревью^"],
        {},
        "готово к ревью\n",
      ],
      ["-- слово", ["col:", "--", "stdin"], {}, "stdin\n"],
      ["col: stdin", ["col:", "stdin"], { stdin: bytes("ok\n") }, "ok\n"],
    ];
  for (const [name, keys, given, out] of cases) {
    it(name, () =>
      withHome(async (home) => {
        await home.write("/home/u/w/x.mpu", "@col print");
        const got = await run(home, ["run:", "x.mpu", ...keys], given);
        expect(seen(got)).toStrictEqual([out, "", 0]);
      }),
    );
  }
});

describe("run: параметры — отказы источника и голое имя", () => {
  const cases: readonly (readonly [
    string,
    string,
    readonly string[],
    readonly [string, string, number],
  ])[] = [
    [
      "не переданный",
      "@col print",
      [],
      [
        "",
        "mpu run: x.mpu: программа ждёт параметр col: — mpu run: x.mpu col: …\n",
        2,
      ],
    ],
    ["связан программой", "col := 1 . @col print", [], ["1\n", "", 0]],
    [
      "совпадает с переменной",
      "col := 1 . @col print",
      ["col:", "review"],
      [
        "",
        "mpu run: x.mpu col: review: параметр col: совпадает с переменной " +
          "col := — переименуй одно из них\n",
        2,
      ],
    ],
    [
      "совпадает с параметром блока",
      "kiten ls each: do :col @col id print done",
      ["col:", "review"],
      [
        "",
        "mpu run: x.mpu col: review: параметр col: совпадает с параметром " +
          "блока :col — переименуй одно из них\n",
        2,
      ],
    ],
    [
      "голое имя — команда",
      "kiten ls end size",
      ["kiten:", "5"],
      ["3\n", "", 0],
    ],
    [
      "параметр — текст",
      "@n plus: 1",
      ["n:", "5"],
      ["", "mpu run: x.mpu n: 5: выражение 1: текст не понимает plus:\n", 1],
    ],
    [
      "@имя в ключе-тексте",
      "telegram send chat: me text: @msg",
      ["msg:", "hi"],
      [
        "",
        "mpu run: x.mpu msg: hi: выражение 1: ключ-текст берёт слово как " +
          "есть; переменную — группой: text: do @msg end\n",
        2,
      ],
    ],
  ];
  for (const [name, text, keys, expected] of cases) {
    it(name, () =>
      withHome(async (home) => {
        await home.write("/home/u/w/x.mpu", text);
        const got = await run(home, ["run:", "x.mpu", ...keys]);
        expect(seen(got)).toStrictEqual(expected);
        if (expected[2] === 2) {
          expect(got.refusals.map((one) => one.hint)).toStrictEqual([null]);
          expect(got.asked, "команды программы не вызваны").toBe(0);
        }
      }),
    );
  }
});

describe("run: отказы разбора и пустой файл — префикс набранной строки", () => {
  const cases: readonly (readonly [
    string,
    string | Uint8Array,
    readonly string[],
    string,
  ])[] = [
    [
      "выражение 2",
      "2 print .\n^a b print",
      ["run:", "x.mpu"],
      "mpu run: x.mpu: выражение 2: текст не закрыт: добавь ^ к последнему слову\n",
    ],
    [
      "ask — в префиксе",
      "^a b print",
      ["ask", "run:", "x.mpu", "col:", "review"],
      "mpu ask run: x.mpu col: review: выражение 1: текст не закрыт: " +
        "добавь ^ к последнему слову\n",
    ],
    ["пуст", "", ["run:", "x.mpu"], "mpu run: x.mpu: программа пуста\n"],
    [
      "только BOM и разделители",
      new Uint8Array([...BOM, ...bytes(" \r\n\t")]),
      ["run:", "x.mpu"],
      "mpu run: x.mpu: программа пуста\n",
    ],
    [
      "run: в тексте файла",
      "2 print . run: y.mpu",
      ["run:", "x.mpu"],
      "mpu run: x.mpu: выражение 2: run: — только первым словом строки\n",
    ],
  ];
  for (const [name, content, words, stderr] of cases) {
    it(name, () =>
      withHome(async (home) => {
        await home.write("/home/u/w/x.mpu", content);
        const got = await run(home, words);
        expect(seen(got)).toStrictEqual(["", stderr, 2]);
        expect(got.refusals.map((one) => one.hint)).toStrictEqual([null]);
      }),
    );
  }
  it("run: в набранной программе", () =>
    withHome(async (home) => {
      const got = await run(home, ["2", "print", ".", "run:", "x.mpu"]);
      expect(seen(got)).toStrictEqual([
        "",
        "выражение 2: run: — только первым словом строки\n",
        2,
      ]);
      expect(got.refusals.map((one) => one.reason)).toStrictEqual([
        "run: не первым словом",
      ]);
    }));
});

describe("run: отказы пути — до чтения, полный путь", () => {
  // Один дом на все шаги, как и до перевода: каталог, файл и канал
  // создаются раз, «нет права чтения» возвращает права сам.
  let home: OpenHome;
  beforeAll(async () => {
    home = await openHome();
    await mkdir(home.real("/home/u/w/dir.mpu"));
    await home.write("/home/u/w/x.mpu", "2 print");
    await mkfifo(home.real("/home/u/w/p.mpu"));
  });
  afterAll(() => home.close());
  const cases: readonly (readonly [
    string,
    readonly string[],
    Call,
    string,
    string,
  ])[] = [
    [
      "нет файла",
      ["run:", "нет.mpu"],
      {},
      "нет файла /home/u/w/нет.mpu",
      "нет файла",
    ],
    [
      "каталог",
      ["run:", "dir.mpu"],
      {},
      "не файл /home/u/w/dir.mpu",
      "не файл",
    ],
    ["канал", ["run:", "p.mpu"], {}, "не файл /home/u/w/p.mpu", "не файл"],
    [
      "stdin — путь, а не ввод",
      ["run:", "stdin"],
      { stdin: bytes("x") },
      "программа — файл .mpu",
      "программа — файл .mpu",
    ],
    [
      "..  в пути",
      ["run:", "../w/./нет.mpu"],
      {},
      "нет файла /home/u/w/нет.mpu",
      "нет файла",
    ],
  ];
  for (const [name, words, given, text, reason] of cases) {
    it(name, async () => {
      const got = await within(run(home, words, given), 10_000, name);
      const said = `mpu ${words.join(" ")}: ${text}`;
      expect(seen(got)).toStrictEqual(["", `${said}\n`, 2]);
      expect(got.refusals).toStrictEqual([
        {
          reason,
          hint: null,
          candidates: [],
          text: said,
        },
      ]);
      expect(got.reads, "ввод не запрошен").toBe(0);
    });
  }
  it("нет права чтения", async () => {
    await chmod(home.real("/home/u/w/x.mpu"), 0o000);
    try {
      const got = await run(home, ["run:", "x.mpu"]);
      expect(seen(got)).toStrictEqual([
        "",
        "mpu run: x.mpu: нет права чтения /home/u/w/x.mpu\n",
        2,
      ]);
    } finally {
      await chmod(home.real("/home/u/w/x.mpu"), 0o644);
    }
  });
  it("нет права чтения — отказ ОС EPERM", async () => {
    // `EPERM` (запрет не по правам файла, например LSM) — тот же ответ, что
    // `EACCES`: Deno сводил оба к `PermissionDenied`.
    const got = await run(home, ["run:", "x.mpu"], {
      readFails: osError("EPERM", "operation not permitted"),
    });
    expect(seen(got)).toStrictEqual([
      "",
      "mpu run: x.mpu: нет права чтения /home/u/w/x.mpu\n",
      2,
    ]);
  });
  it("run: без значения", async () => {
    const got = await run(home, ["run:"]);
    expect(seen(got)).toStrictEqual(["", "у ключа run нет значения\n", 2]);
  });
});

describe("run: байты файла — BOM и \\r снимаются, NBSP — часть слова, не UTF-8 — отказ", () => {
  const cp1251 = [
    0x5e, 0xc3, 0xee, 0xf2, 0xee, 0xe2, 0xee, 0x5e, 0x20, 0x70, 0x72, 0x69,
    0x6e, 0x74,
  ];
  const cases: readonly (readonly [
    string,
    Uint8Array,
    readonly [string, string, number],
  ])[] = [
    [
      "BOM и \\r\\n",
      new Uint8Array([...BOM, ...bytes("^готово к ревью^ print\r\n")]),
      ["готово к ревью\n", "", 0],
    ],
    [
      "\\r\\n внутри текста",
      bytes("^готово\r\nк ревью^ print\r\n"),
      ["готово к ревью\n", "", 0],
    ],
    ["NBSP", bytes("^готово к ревью^ print"), ["готово к ревью\n", "", 0]],
    [
      "cp1251",
      new Uint8Array(cp1251),
      ["", "mpu run: x.mpu: файл не в UTF-8: байт 0xC3 на смещении 1\n", 2],
    ],
    [
      "cp1251 после BOM",
      new Uint8Array([...BOM, ...cp1251]),
      ["", "mpu run: x.mpu: файл не в UTF-8: байт 0xC3 на смещении 4\n", 2],
    ],
  ];
  for (const [name, content, expected] of cases) {
    it(name, () =>
      withHome(async (home) => {
        await home.write("/home/u/w/x.mpu", content);
        expect(seen(await run(home, ["run:", "x.mpu"]))).toStrictEqual(
          expected,
        );
      }),
    );
  }
  it("одни слова из файла и из stdin", () =>
    withHome(async (home) => {
      const text = new Uint8Array([
        ...BOM,
        ...bytes("^готово к ревью^ print\r\n"),
      ]);
      await home.write("/home/u/w/x.mpu", text);
      const file = await run(home, ["run:", "x.mpu"]);
      const piped = await run(home, [], { stdin: text });
      expect(seen(file)).toStrictEqual(seen(piped));
    }));
});

/** Журнал вызовов; строка, не дошедшая до исполнения, записи не даёт. */
async function journalOf(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/** Нет ли токена ни в одном выводе строки и в записи журнала. */
function assertSecretKept(got: Called, journal: string) {
  const everywhere = [
    got.stdout,
    got.stderr,
    JSON.stringify(got.refusals),
    journal,
  ];
  expect(everywhere.filter((text) => text.includes(SECRET))).toStrictEqual([]);
}

describe("run: секрет — файл не открывается, токена нет нигде", () => {
  // Один дом и один журнал на все шаги, как и до перевода: проверка
  // секрета смотрит журнал целиком.
  let home: OpenHome;
  beforeAll(async () => {
    home = await openHome();
    await home.write("/home/u/.config/mpu/x.mpu", "2 print");
    await home.write("/home/u/xdg/mpu/x.mpu", "2 print");
    await symlink(
      home.real("/home/u/.config/mpu/token"),
      home.real("/home/u/w/t.mpu"),
    );
    await symlink(
      home.real("/home/u/.ssh/id_ed25519"),
      home.real("/home/u/w/k.mpu"),
    );
    await link(
      home.real("/home/u/.config/mpu/token"),
      home.real("/home/u/w/h.mpu"),
    );
  });
  afterAll(() => home.close());
  const settings = "каталог настроек mpu программой не читается";
  const cases: readonly (readonly [string, string, string])[] = [
    [
      "/home/u/.config/mpu/mcp-token",
      "программа — файл .mpu",
      "программа — файл .mpu",
    ],
    ["/home/u/.config/mpu/x.mpu", settings, "каталог настроек не читается"],
    ["/home/u/xdg/mpu/x.mpu", settings, "каталог настроек не читается"],
    ["t.mpu", settings, "каталог настроек не читается"],
    [
      "k.mpu",
      "программа — файл .mpu, а /home/u/w/k.mpu ведёт в /home/u/.ssh/id_ed25519",
      "программа — файл .mpu",
    ],
    [
      "h.mpu",
      "у файла несколько ссылок — программой не читается",
      "несколько ссылок",
    ],
  ];
  for (const [path, text, reason] of cases) {
    it(path, async () => {
      const log = home.real("/home/u/w/journal.log");
      const got = await run(home, ["run:", home.real(path)], { log });
      const said = `mpu run: ${path}: ${text}`;
      expect(seen(got)).toStrictEqual(["", `${said}\n`, 2]);
      expect(got.refusals.map((one) => one.reason)).toStrictEqual([reason]);
      assertSecretKept(got, await journalOf(log));
    });
  }
});

it("run: журнал — строка маскируется по командам программы", async () => {
  await withHome(async (home) => {
    await home.write("/home/u/w/x.mpu", "telegram log text: do @msg end");
    const log = home.real("/home/u/w/journal.log");
    const got = await run(home, ["run:", "x.mpu", "msg:", "личное"], {
      log,
      botless: true,
    });
    const journal = await journalOf(log);
    assert(
      journal.includes("$ mpu REDACTED REDACTED REDACTED REDACTED\n"),
      journal,
    );
    expect(journal.includes("личное"), journal).toBe(false);
    expect(got.stdout.includes("личное")).toBe(false);
  });
});

describe("run: ask и правила", () => {
  const write = "kiten comment id: 11 text: a";
  const question = "выполнить mpu kiten comment id: 11 text: a? [y/N] ";
  // Шаги идут по одному дому: x.mpu пишет первый шаг, его исполняют
  // следующие.
  let home: OpenHome;
  beforeAll(async () => {
    home = await openHome();
    await home.write("/home/u/w/y.mpu", `ask ${write}`);
  });
  afterAll(() => home.close());
  it("без двери — отказ всей строки с готовой строкой", async () => {
    await home.write("/home/u/w/x.mpu", write);
    const got = await run(home, ["run:", "x.mpu"]);
    expect(seen(got)).toStrictEqual([
      "",
      "mpu run: x.mpu: строка может записать (kiten comment) — начни с " +
        "ask: mpu ask run: x.mpu\n",
      2,
    ]);
    expect(got.refusals.map((one) => one.hint)).toStrictEqual([
      ["ask", "run:", "x.mpu"],
    ]);
    expect(got.posted).toStrictEqual([]);
  });
  it("mpu ask run:, y", async () => {
    const got = await run(home, ["ask", "run:", "x.mpu"], { answers: ["y"] });
    expect(seen(got).slice(1)).toStrictEqual([question, 0]);
    expect(got.posted).toStrictEqual(["11 a"]);
  });
  it("mpu ask run:, n", async () => {
    const got = await run(home, ["ask", "run:", "x.mpu"], { answers: ["n"] });
    expect(seen(got)).toStrictEqual([
      "",
      `${question}mpu kiten comment id: 11 text: a: не подтверждено\n`,
      1,
    ]);
    expect(got.posted).toStrictEqual([]);
  });
  it("ask в тексте файла, y", async () => {
    const got = await run(home, ["run:", "y.mpu"], { answers: ["y"] });
    expect(seen(got).slice(1)).toStrictEqual([question, 0]);
    expect(got.posted).toStrictEqual(["11 a"]);
  });
  it("ask в тексте, человека нет", async () => {
    const got = await run(home, ["run:", home.real("/home/u/w/y.mpu")], {
      nobody: true,
    });
    expect(seen(got)).toStrictEqual([
      "",
      "mpu kiten comment id: 11 text: a: нужно подтверждение, а спросить " +
        "некого\n",
      1,
    ]);
    expect(got.posted).toStrictEqual([]);
  });
  it("ask и снаружи, и в тексте — один вопрос", async () => {
    const got = await run(home, ["ask", "run:", "y.mpu"], { answers: ["y"] });
    expect(seen(got).slice(1)).toStrictEqual([question, 0]);
    expect(got.posted).toStrictEqual(["11 a"]);
  });
  it("запрет правилом", async () => {
    await home.write("/home/u/w/s.mpu", "sql target: 1 sql: x");
    const got = await run(home, ["ask", "run:", "s.mpu"]);
    expect(seen(got)).toStrictEqual([
      "",
      "mpu sql: запрещено правилом «sql»\n",
      1,
    ]);
  });
  it("policy — run: не узел правил", async () => {
    const got = await run(home, ["policy"]);
    expect(got.exit).toBe(0);
    expect(got.stdout.includes("run:"), got.stdout).toBe(false);
  });
  it("deny: run: — у ключа нет значения", async () => {
    const got = await run(home, ["deny:", "run:"]);
    expect(seen(got)).toStrictEqual(["", "у ключа deny нет значения\n", 2]);
  });
});

describe("run: справка, дополнение и путь от каталога строки", () => {
  // Один дом на все шаги, как и до перевода: x.mpu в /home/u писался
  // посреди шагов для последнего; прежним шагам лишний файл не мешает.
  let home: OpenHome;
  beforeAll(async () => {
    home = await openHome();
    await home.write("/home/u/x.mpu", "@col print");
  });
  afterAll(() => home.close());
  const line = "  run:";
  const purpose = "исполнить программу из файла .mpu";
  it("mpu run: help", async () => {
    const got = await run(home, ["run:", "help"]);
    expect(seen(got)).toStrictEqual([
      "Использование: mpu run: <файл.mpu> [<ключ>: <значение>]…\n\n" +
        `${purpose}\n\n` +
        "Звать, когда программа длиннее строки или ломается на кавычках " +
        "оболочки:\nфайл делится по пробелам так же, как строка, а @ключ " +
        "внутри берёт значение\nиз ключа вызова (mpu run: x.mpu col: " +
        "review). Без слов программа берётся\nиз stdin: mpu < x.mpu.\n",
      "",
      0,
    ]);
  });
  for (const words of [["help"], ["ask", "help"]]) {
    it(words.join(" "), async () => {
      const got = await run(home, words);
      const lines = got.stdout.split("\n");
      const at = lines.findIndex((one) => one.startsWith(line));
      assert(at >= 0, got.stdout);
      expect(lines[at].trim().replace(/ +/, " ")).toStrictEqual(
        `run: ${purpose}`,
      );
      const names = lines
        .slice(at - 1, at + 2)
        .filter((one) => one !== "")
        .map((one) => one.trim().split(" ")[0]);
      expect(names, "порядок побайтный").toStrictEqual([...names].sort());
    });
  }
  it("complete: ru", async () => {
    const got = await run(home, ["complete:", "ru"]);
    assert(got.stdout.split("\n").includes(`run:\t${purpose}`), got.stdout);
  });
  it("complete: run: — значение дополняет оболочка", async () => {
    expect(seen(await run(home, ["complete:", "run: "]))).toStrictEqual([
      "",
      "",
      0,
    ]);
  });
  it("путь от каталога строки (у MCP — домашний)", async () => {
    const got = await run(home, ["run:", "x.mpu", "col:", "review"], {
      cwd: "/home/u",
    });
    expect(seen(got)).toStrictEqual(["review\n", "", 0]);
  });
  it("нет файла от каталога строки", async () => {
    const got = await run(home, ["run:", "x.mpu"], { cwd: "/home/u/w" });
    expect(seen(got)).toStrictEqual([
      "",
      "mpu run: x.mpu: нет файла /home/u/w/x.mpu\n",
      2,
    ]);
  });
});

describe("run: ключи вызова — отказы разбора до исполнения", () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [["col:"], "у ключа col нет значения"],
    [["col:", "next:", "1"], "у ключа col нет значения"],
    [["col:", "--"], "после -- нет слова"],
    [["col:", "^a", "b"], "текст не закрыт: добавь ^ к последнему слову"],
    [["review"], "не понимает review"],
  ];
  for (const [keys, text] of cases) {
    it(keys.join(" "), () =>
      withHome(async (home) => {
        await home.write("/home/u/w/x.mpu", "@col print");
        const words = ["run:", "x.mpu", ...keys];
        const got = await run(home, words);
        expect(seen(got)).toStrictEqual([
          "",
          `mpu ${words.join(" ")}: ${text}\n`,
          2,
        ]);
        expect(got.refusals.map((one) => one.hint)).toStrictEqual([null]);
      }),
    );
  }
});
