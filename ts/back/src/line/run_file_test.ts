/**
 * Программа из файла `run:` (`platform/program-input.md`, порция 170b):
 * «Файл и параметры», «Байты файла», «Секрет», «`ask` и правила»,
 * «Справка, дополнение и MCP». Стенд — `ask-composite.md`: `kiten ls`
 * allow, `kiten comment` ask, `sql` deny. Домашний каталог — временный:
 * `<tmp>/u`, каталог вызова `<tmp>/u/w`, `XDG_CONFIG_HOME=<tmp>/u/xdg`;
 * в тексте ожиданий он пишется `/home/u`. Файлы секретов — синтетические.
 */

import { assert, assertEquals } from "@std/assert";
import { type CommandIo, DomainError } from "../command/mod.ts";
import { makeInvokeLog } from "../invokelog/mod.ts";
import { ASK, DENY, Human, NOBODY, RuleBook, RulePath } from "../policy/mod.ts";
import { type ChannelOf, programFiles } from "./mod.ts";
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

/** Временный `/home/u` с каталогом вызова `w` и токеном в настройках. */
async function withHome(fn: (home: Home) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const root = `${dir}/u`;
  const home: Home = {
    root,
    real: (text) => text.replaceAll("/home/u", root),
    write: async (path, content) => {
      const full = home.real(path);
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      const data = typeof content === "string" ? bytes(content) : content;
      await Deno.writeFile(full, data);
    },
  };
  try {
    await Deno.mkdir(`${root}/w`, { recursive: true });
    await home.write("/home/u/.config/mpu/token", SECRET);
    await home.write("/home/u/.config/mpu/mcp-token", SECRET);
    await home.write("/home/u/.ssh/id_ed25519", SECRET);
    await fn(home);
  } finally {
    await Deno.chmod(root, 0o755).catch(() => {});
    await Deno.remove(dir, { recursive: true });
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
      const log = given.log === undefined ? undefined : makeInvokeLog({
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
        files: programFiles((name) => env[name]),
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
    })
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

Deno.test("run: файл и параметры — значение ключа вызова", async (t) => {
  await withHome(async (home) => {
    await home.write("/home/u/w/x.mpu", "@col print");
    const cases:
      readonly (readonly [string, readonly string[], Call, string])[] = [
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
      await t.step(name, async () => {
        const got = await run(home, ["run:", "x.mpu", ...keys], given);
        assertEquals(seen(got), [out, "", 0]);
      });
    }
  });
});

Deno.test("run: параметры — отказы источника и голое имя", async (t) => {
  await withHome(async (home) => {
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
      ["голое имя — команда", "kiten ls end size", ["kiten:", "5"], [
        "3\n",
        "",
        0,
      ]],
      ["параметр — текст", "@n plus: 1", ["n:", "5"], [
        "",
        "mpu run: x.mpu n: 5: выражение 1: текст не понимает plus:\n",
        1,
      ]],
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
      await t.step(name, async () => {
        await home.write("/home/u/w/x.mpu", text);
        const got = await run(home, ["run:", "x.mpu", ...keys]);
        assertEquals(seen(got), expected);
        if (expected[2] === 2) {
          assertEquals(got.refusals.map((one) => one.hint), [null]);
          assertEquals(got.asked, 0, "команды программы не вызваны");
        }
      });
    }
  });
});

Deno.test("run: отказы разбора и пустой файл — префикс набранной строки", async (t) => {
  await withHome(async (home) => {
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
      await t.step(name, async () => {
        await home.write("/home/u/w/x.mpu", content);
        const got = await run(home, words);
        assertEquals(seen(got), ["", stderr, 2]);
        assertEquals(got.refusals.map((one) => one.hint), [null]);
      });
    }
    await t.step("run: в набранной программе", async () => {
      const got = await run(home, ["2", "print", ".", "run:", "x.mpu"]);
      assertEquals(seen(got), [
        "",
        "выражение 2: run: — только первым словом строки\n",
        2,
      ]);
      assertEquals(got.refusals.map((one) => one.reason), [
        "run: не первым словом",
      ]);
    });
  });
});

Deno.test("run: отказы пути — до чтения, полный путь", async (t) => {
  await withHome(async (home) => {
    await Deno.mkdir(home.real("/home/u/w/dir.mpu"));
    await home.write("/home/u/w/x.mpu", "2 print");
    const fifo = new Deno.Command("/bin/sh", {
      args: ["-c", `mkfifo '${home.real("/home/u/w/p.mpu")}'`],
    });
    assertEquals((await fifo.output()).code, 0);
    const cases:
      readonly (readonly [string, readonly string[], Call, string, string])[] =
        [
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
          [
            "канал",
            ["run:", "p.mpu"],
            {},
            "не файл /home/u/w/p.mpu",
            "не файл",
          ],
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
      await t.step(name, async () => {
        const got = await within(run(home, words, given), 10_000, name);
        const said = `mpu ${words.join(" ")}: ${text}`;
        assertEquals(seen(got), ["", `${said}\n`, 2]);
        assertEquals(got.refusals, [{
          reason,
          hint: null,
          candidates: [],
          text: said,
        }]);
        assertEquals(got.reads, 0, "ввод не запрошен");
      });
    }
    await t.step("нет права чтения", async () => {
      await Deno.chmod(home.real("/home/u/w/x.mpu"), 0o000);
      try {
        const got = await run(home, ["run:", "x.mpu"]);
        assertEquals(seen(got), [
          "",
          "mpu run: x.mpu: нет права чтения /home/u/w/x.mpu\n",
          2,
        ]);
      } finally {
        await Deno.chmod(home.real("/home/u/w/x.mpu"), 0o644);
      }
    });
    await t.step("run: без значения", async () => {
      const got = await run(home, ["run:"]);
      assertEquals(seen(got), ["", "у ключа run нет значения\n", 2]);
    });
  });
});

Deno.test("run: байты файла — BOM и \\r снимаются, NBSP — часть слова, не UTF-8 — отказ", async (t) => {
  await withHome(async (home) => {
    const cp1251 = [
      0x5e,
      0xc3,
      0xee,
      0xf2,
      0xee,
      0xe2,
      0xee,
      0x5e,
      0x20,
      0x70,
      0x72,
      0x69,
      0x6e,
      0x74,
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
      [
        "NBSP",
        bytes("^готово к ревью^ print"),
        ["готово к ревью\n", "", 0],
      ],
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
      await t.step(name, async () => {
        await home.write("/home/u/w/x.mpu", content);
        assertEquals(seen(await run(home, ["run:", "x.mpu"])), expected);
      });
    }
    await t.step("одни слова из файла и из stdin", async () => {
      const text = new Uint8Array([
        ...BOM,
        ...bytes("^готово к ревью^ print\r\n"),
      ]);
      await home.write("/home/u/w/x.mpu", text);
      const file = await run(home, ["run:", "x.mpu"]);
      const piped = await run(home, [], { stdin: text });
      assertEquals(seen(file), seen(piped));
    });
  });
});

/** Журнал вызовов; строка, не дошедшая до исполнения, записи не даёт. */
async function journalOf(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
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
  assertEquals(everywhere.filter((text) => text.includes(SECRET)), []);
}

Deno.test("run: секрет — файл не открывается, токена нет нигде", async (t) => {
  await withHome(async (home) => {
    await home.write("/home/u/.config/mpu/x.mpu", "2 print");
    await home.write("/home/u/xdg/mpu/x.mpu", "2 print");
    await Deno.symlink(
      home.real("/home/u/.config/mpu/token"),
      home.real("/home/u/w/t.mpu"),
    );
    await Deno.symlink(
      home.real("/home/u/.ssh/id_ed25519"),
      home.real("/home/u/w/k.mpu"),
    );
    await Deno.link(
      home.real("/home/u/.config/mpu/token"),
      home.real("/home/u/w/h.mpu"),
    );
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
      await t.step(path, async () => {
        const log = home.real("/home/u/w/journal.log");
        const got = await run(home, ["run:", home.real(path)], { log });
        const said = `mpu run: ${path}: ${text}`;
        assertEquals(seen(got), ["", `${said}\n`, 2]);
        assertEquals(got.refusals.map((one) => one.reason), [reason]);
        assertSecretKept(got, await journalOf(log));
      });
    }
  });
});

Deno.test("run: журнал — строка маскируется по командам программы", async () => {
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
    assertEquals(journal.includes("личное"), false, journal);
    assertEquals(got.stdout.includes("личное"), false);
  });
});

Deno.test("run: ask и правила", async (t) => {
  await withHome(async (home) => {
    const write = "kiten comment id: 11 text: a";
    const question = "выполнить mpu kiten comment id: 11 text: a? [y/N] ";
    await t.step(
      "без двери — отказ всей строки с готовой строкой",
      async () => {
        await home.write("/home/u/w/x.mpu", write);
        const got = await run(home, ["run:", "x.mpu"]);
        assertEquals(seen(got), [
          "",
          "mpu run: x.mpu: строка может записать (kiten comment) — начни с " +
          "ask: mpu ask run: x.mpu\n",
          2,
        ]);
        assertEquals(got.refusals.map((one) => one.hint), [[
          "ask",
          "run:",
          "x.mpu",
        ]]);
        assertEquals(got.posted, []);
      },
    );
    await t.step("mpu ask run:, y", async () => {
      const got = await run(home, ["ask", "run:", "x.mpu"], { answers: ["y"] });
      assertEquals(seen(got).slice(1), [question, 0]);
      assertEquals(got.posted, ["11 a"]);
    });
    await t.step("mpu ask run:, n", async () => {
      const got = await run(home, ["ask", "run:", "x.mpu"], { answers: ["n"] });
      assertEquals(seen(got), [
        "",
        `${question}mpu kiten comment id: 11 text: a: не подтверждено\n`,
        1,
      ]);
      assertEquals(got.posted, []);
    });
    await home.write("/home/u/w/y.mpu", `ask ${write}`);
    await t.step("ask в тексте файла, y", async () => {
      const got = await run(home, ["run:", "y.mpu"], { answers: ["y"] });
      assertEquals(seen(got).slice(1), [question, 0]);
      assertEquals(got.posted, ["11 a"]);
    });
    await t.step("ask в тексте, человека нет", async () => {
      const got = await run(home, ["run:", home.real("/home/u/w/y.mpu")], {
        nobody: true,
      });
      assertEquals(seen(got), [
        "",
        "mpu kiten comment id: 11 text: a: нужно подтверждение, а спросить " +
        "некого\n",
        1,
      ]);
      assertEquals(got.posted, []);
    });
    await t.step("ask и снаружи, и в тексте — один вопрос", async () => {
      const got = await run(home, ["ask", "run:", "y.mpu"], { answers: ["y"] });
      assertEquals(seen(got).slice(1), [question, 0]);
      assertEquals(got.posted, ["11 a"]);
    });
    await t.step("запрет правилом", async () => {
      await home.write("/home/u/w/s.mpu", "sql target: 1 sql: x");
      const got = await run(home, ["ask", "run:", "s.mpu"]);
      assertEquals(seen(got), ["", "mpu sql: запрещено правилом «sql»\n", 1]);
    });
    await t.step("policy — run: не узел правил", async () => {
      const got = await run(home, ["policy"]);
      assertEquals(got.exit, 0);
      assertEquals(got.stdout.includes("run:"), false, got.stdout);
    });
    await t.step("deny: run: — у ключа нет значения", async () => {
      const got = await run(home, ["deny:", "run:"]);
      assertEquals(seen(got), ["", "у ключа deny нет значения\n", 2]);
    });
  });
});

Deno.test("run: справка, дополнение и путь от каталога строки", async (t) => {
  await withHome(async (home) => {
    const line = "  run:";
    const purpose = "исполнить программу из файла .mpu";
    await t.step("mpu run: help", async () => {
      const got = await run(home, ["run:", "help"]);
      assertEquals(seen(got), [
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
      await t.step(words.join(" "), async () => {
        const got = await run(home, words);
        const lines = got.stdout.split("\n");
        const at = lines.findIndex((one) => one.startsWith(line));
        assert(at >= 0, got.stdout);
        assertEquals(lines[at].trim().replace(/ +/, " "), `run: ${purpose}`);
        const names = lines.slice(at - 1, at + 2).filter((one) => one !== "")
          .map((one) => one.trim().split(" ")[0]);
        assertEquals(names, [...names].sort(), "порядок побайтный");
      });
    }
    await t.step("complete: ru", async () => {
      const got = await run(home, ["complete:", "ru"]);
      assert(got.stdout.split("\n").includes(`run:\t${purpose}`), got.stdout);
    });
    await t.step("complete: run: — значение дополняет оболочка", async () => {
      assertEquals(seen(await run(home, ["complete:", "run: "])), ["", "", 0]);
    });
    await home.write("/home/u/x.mpu", "@col print");
    await t.step("путь от каталога строки (у MCP — домашний)", async () => {
      const got = await run(home, ["run:", "x.mpu", "col:", "review"], {
        cwd: "/home/u",
      });
      assertEquals(seen(got), ["review\n", "", 0]);
    });
    await t.step("нет файла от каталога строки", async () => {
      const got = await run(home, ["run:", "x.mpu"], { cwd: "/home/u/w" });
      assertEquals(seen(got), [
        "",
        "mpu run: x.mpu: нет файла /home/u/w/x.mpu\n",
        2,
      ]);
    });
  });
});

Deno.test("run: ключи вызова — отказы разбора до исполнения", async (t) => {
  await withHome(async (home) => {
    await home.write("/home/u/w/x.mpu", "@col print");
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["col:"], "у ключа col нет значения"],
      [["col:", "next:", "1"], "у ключа col нет значения"],
      [["col:", "--"], "после -- нет слова"],
      [["col:", "^a", "b"], "текст не закрыт: добавь ^ к последнему слову"],
      [["review"], "не понимает review"],
    ];
    for (const [keys, text] of cases) {
      await t.step(keys.join(" "), async () => {
        const words = ["run:", "x.mpu", ...keys];
        const got = await run(home, words);
        assertEquals(seen(got), ["", `mpu ${words.join(" ")}: ${text}\n`, 2]);
        assertEquals(got.refusals.map((one) => one.hint), [null]);
      });
    }
  });
});
