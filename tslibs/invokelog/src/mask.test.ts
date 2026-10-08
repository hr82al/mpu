import { describe, expect, it } from "vitest";
import { commandLine, maskJsonText, toolCommandLine } from "./mask.ts";

describe("строка команды: shell-кавычение аргументов", () => {
  const cases: readonly [name: string, argv: string[], line: string][] = [
    ["простые аргументы как есть", ["xlsx", "ls"], "mpu xlsx ls"],
    [
      "пробел — одинарные кавычки",
      ["sql-ro", "sl-1", "SELECT 1 AS one", "--json"],
      "mpu sql-ro sl-1 'SELECT 1 AS one' --json",
    ],
    ["пустой аргумент — пара кавычек", ["search", ""], "mpu search ''"],
    [
      "одинарная кавычка внутри — разрыв склейкой",
      ["search", "it's"],
      `mpu search 'it'"'"'s'`,
    ],
    [
      "кириллица — без кавычек, как у оригинала",
      ["ls", "Отчёт"],
      "mpu ls Отчёт",
    ],
    [
      "путь и дефисы — без кавычек",
      ["xlsx", "./a-b.xlsx"],
      "mpu xlsx ./a-b.xlsx",
    ],
    ["звёздочка — под кавычки", ["ls", "*"], "mpu ls '*'"],
    ["без аргументов — только литеральное имя", [], "mpu"],
  ];
  for (const [name, argv, line] of cases) {
    it(name, () => expect(commandLine(argv)).toStrictEqual(line));
  }
});

describe("маскирование значений секретных опций", () => {
  const cases: readonly [name: string, argv: string[], line: string][] = [
    [
      "форма --opt=value",
      ["sql-ro", "sl-1", "--token=abc"],
      "mpu sql-ro sl-1 --token=REDACTED",
    ],
    [
      "форма --opt value",
      ["sql-ro", "--token", "abc"],
      "mpu sql-ro --token REDACTED",
    ],
    [
      "имя содержит password",
      ["--pg-password", "s3"],
      "mpu --pg-password REDACTED",
    ],
    [
      "имя содержит secret",
      ["--client-secret=s3"],
      "mpu --client-secret=REDACTED",
    ],
    ["имя содержит api-key", ["--api-key", "s3"], "mpu --api-key REDACTED"],
    ["имя содержит api_key", ["--api_key", "s3"], "mpu --api_key REDACTED"],
    [
      "имя содержит session",
      ["--session-id", "s3"],
      "mpu --session-id REDACTED",
    ],
    ["регистр имени не важен", ["--TOKEN", "s3"], "mpu --TOKEN REDACTED"],
    ["короткая опция с тем же корнем", ["-token", "s3"], "mpu -token REDACTED"],
    [
      "секрет с пробелами не проступает через кавычки",
      ["--token", "a b"],
      "mpu --token REDACTED",
    ],
    [
      "несекретная опция не трогается",
      ["--profile", "ro", "--json"],
      "mpu --profile ro --json",
    ],
    [
      "позиционный аргумент после несекретной опции остаётся",
      ["--limit", "10", "token"],
      "mpu --limit 10 token",
    ],
    ["секретная опция без значения", ["--token"], "mpu --token"],
    [
      "@file-индирекция не разворачивается",
      ["--token", "@/etc/secret"],
      "mpu --token REDACTED",
    ],
  ];
  for (const [name, argv, line] of cases) {
    it(name, () => expect(commandLine(argv)).toStrictEqual(line));
  }
});

describe("маскирование JSON в теле -b/--body", () => {
  it("рекурсивно по ключам, обе формы записи", () => {
    expect(
      commandLine([
        "api",
        "--body",
        '{"a":{"token":"x"},"b":[{"password":1}]}',
      ]),
    ).toBe(
      `mpu api --body '{"a":{"token":"REDACTED"},"b":[{"password":"REDACTED"}]}'`,
    );
    expect(commandLine(["api", "-b", '{"session":"x"}'])).toBe(
      `mpu api -b '{"session":"REDACTED"}'`,
    );
  });
  it("форма --body=<json>", () => {
    expect(commandLine(["api", '--body={"token":"x"}'])).toBe(
      `mpu api '--body={"token":"REDACTED"}'`,
    );
  });
  it("у формы --opt=value значение не пишется", () => {
    // Имя остаётся, значение — нет, и это не зависит от имени: список
    // секретных имён слеп к опечатке, а `--pasword=hunter2` мимо него
    // проходит. Форма с пробелом при этом читается как прежде: там
    // значение отдельным словом, и по имени опции видно, что это.
    expect(commandLine(["api", "--limit=10"])).toBe("mpu api --limit=REDACTED");
    expect(commandLine(["api", "--pasword=hunter2"])).toBe(
      "mpu api --pasword=REDACTED",
    );
  });
  it("невалидный JSON не трогается", () => {
    expect(commandLine(["api", "-b", "{oops"])).toBe("mpu api -b '{oops'");
  });
  it("секретов нет — текст дословный, без пересборки", () => {
    expect(commandLine(["api", "-b", '{ "a" : 1 }'])).toBe(
      `mpu api -b '{ "a" : 1 }'`,
    );
  });
  it("@file-индирекция тела не разворачивается", () => {
    expect(commandLine(["api", "-b", "@body.json"])).toBe(
      "mpu api -b @body.json",
    );
  });
});

describe("строка команды вызова тула MCP-сервером", () => {
  it("путь через пробел и JSON одной строкой", () => {
    expect(
      toolCommandLine(["xlsx", "ls"], { path: "/tmp/a b.xlsx", sheet: 1 }),
    ).toBe(`mpu xlsx ls '{"path":"/tmp/a b.xlsx","sheet":1}'`);
  });
  it("секретные ключи маскируются рекурсивно", () => {
    expect(toolCommandLine(["api"], { auth: { token: "x" }, keep: true })).toBe(
      `mpu api '{"auth":{"token":"REDACTED"},"keep":true}'`,
    );
  });
  it("аргументов нет — пустой объект", () => {
    expect(toolCommandLine(["version"], {})).toBe(`mpu version '{}'`);
  });
  it("аргументы не сериализуемы — литерал null", () => {
    expect(toolCommandLine(["version"], undefined)).toBe("mpu version null");
  });
});

describe("маскирование текста JSON — отдельная поверхность", () => {
  it("массив верхнего уровня", () => {
    expect(maskJsonText('[{"token":"x"}]')).toBe('[{"token":"REDACTED"}]');
  });
  it("скаляр верхнего уровня не меняется", () => {
    expect(maskJsonText('"token"')).toBe('"token"');
  });
  it("null-значение секретного ключа тоже маскируется", () => {
    expect(maskJsonText('{"token":null}')).toBe('{"token":"REDACTED"}');
  });
});

it("помеченная команда: аргументы после пути заменены маской", () => {
  expect(
    commandLine(["telegram", "log", "личная заметка"], {
      path: ["telegram", "log"],
    }),
  ).toBe("mpu telegram log REDACTED");
});

it("помеченная команда: маскируется каждый аргумент, не только первый", () => {
  expect(
    commandLine(["telegram", "log", "текст", "--чужое", "значение"], {
      path: ["telegram", "log"],
    }),
  ).toBe("mpu telegram log REDACTED REDACTED REDACTED");
});

it("путь команды маской не трогается", () => {
  expect(commandLine(["telegram", "log"], { path: ["telegram", "log"] })).toBe(
    "mpu telegram log",
  );
});

it("помеченная команда: путь в argv не сплошной префикс — общий --json между сегментами", () => {
  // `--json` — общий флаг любого уровня (тест точки входа `ts/`,
  // `back/src/entrypoint/mod.test.ts`, `xlsx --json alias ls`): у
  // помеченной команды он тоже аргумент, а не часть пути, поэтому граница
  // ищется сопоставлением с путём, а не длиной префикса — иначе
  // замаскировался бы сегмент пути `log`.
  expect(
    commandLine(["telegram", "--json", "log", "текст"], {
      path: ["telegram", "log"],
    }),
  ).toBe("mpu telegram REDACTED log REDACTED");
});

it("помеченная команда: слово аргумента совпадает со словом пути — не принимается за путь", () => {
  // Путь уже пройден целиком двумя первыми элементами — второе
  // совпадение с "log" это уже текст заметки, а не сегмент пути.
  expect(
    commandLine(["telegram", "log", "log"], {
      path: ["telegram", "log"],
    }),
  ).toBe("mpu telegram log REDACTED");
});

it("без пометки правило прежнее: маскируются только опции-секреты", () => {
  expect(commandLine(["telegram", "send", "привет"])).toBe(
    "mpu telegram send привет",
  );
});

it("помеченный тул: JSON аргументов заменён маской целиком", () => {
  expect(
    toolCommandLine(
      ["telegram", "log"],
      { message: "личное" },
      {
        masked: true,
      },
    ),
  ).toBe("mpu telegram log REDACTED");
});

describe("значение объявленной опции пишется, необъявленной — нет", () => {
  // Объявления команды: `--limit` берёт значение, `--json` булев.
  const options = [
    { names: ["--limit", "-l"], takesValue: true },
    { names: ["--json"], takesValue: false },
  ];

  it("объявленная читается в обеих формах", () => {
    expect(commandLine(["log", "--limit", "10"], { options })).toBe(
      "mpu log --limit 10",
    );
    expect(commandLine(["log", "--limit=10"], { options })).toBe(
      "mpu log --limit=10",
    );
    // Цена прежней границы отменена: `--limit=REDACTED` больше нет.
    expect(commandLine(["log", "-l", "10"], { options })).toBe("mpu log -l 10");
  });

  it("необъявленная прячет значение в обеих формах", () => {
    // Опечатка в имени секретной опции проходит мимо любого списка
    // имён — отличить её от обычной можно только по объявлению.
    expect(commandLine(["log", "--pasword", "hunter2"], { options })).toBe(
      "mpu log --pasword REDACTED",
    );
    expect(commandLine(["log", "--pasword=hunter2"], { options })).toBe(
      "mpu log --pasword=REDACTED",
    );
  });

  it("булев флаг не съедает соседний токен", () => {
    // `--json` значения не берёт: следующее слово — не его, и прятать
    // его значило бы прятать чужое.
    expect(commandLine(["log", "--json", "sl-1"], { options })).toBe(
      "mpu log --json sl-1",
    );
  });

  it("без объявлений — прежнее правило по виду токена", () => {
    // Запись делается и для вызова, которого реестр не знает: тогда
    // прячется значение формы с «=», как было до правила.
    expect(commandLine(["log", "--limit=10"])).toBe("mpu log --limit=REDACTED");
  });

  it("чужая командная строка не трогается", () => {
    // Хвост `ssh` — не наши опции: ради него запись и читают.
    expect(
      commandLine(["ssh", "sl-9", "psql", "--tuples-only", "x"], {
        options,
        foreignTail: true,
      }),
    ).toBe("mpu ssh sl-9 psql --tuples-only x");
  });
});
