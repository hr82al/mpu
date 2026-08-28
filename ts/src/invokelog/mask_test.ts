import { assertEquals } from "@std/assert";
import { commandLine, maskJsonText, toolCommandLine } from "./mask.ts";

Deno.test("строка команды: shell-кавычение аргументов", async (t) => {
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
    await t.step(name, () => assertEquals(commandLine(argv), line));
  }
});

Deno.test("маскирование значений секретных опций", async (t) => {
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
    await t.step(name, () => assertEquals(commandLine(argv), line));
  }
});

Deno.test("маскирование JSON в теле -b/--body", async (t) => {
  await t.step("рекурсивно по ключам, обе формы записи", () => {
    assertEquals(
      commandLine([
        "api",
        "--body",
        '{"a":{"token":"x"},"b":[{"password":1}]}',
      ]),
      `mpu api --body '{"a":{"token":"REDACTED"},"b":[{"password":"REDACTED"}]}'`,
    );
    assertEquals(
      commandLine(["api", "-b", '{"session":"x"}']),
      `mpu api -b '{"session":"REDACTED"}'`,
    );
  });
  await t.step("форма --body=<json>", () => {
    assertEquals(
      commandLine(["api", '--body={"token":"x"}']),
      `mpu api '--body={"token":"REDACTED"}'`,
    );
  });
  await t.step("у формы --opt=value значение не пишется", () => {
    // Имя остаётся, значение — нет, и это не зависит от имени: список
    // секретных имён слеп к опечатке, а `--pasword=hunter2` мимо него
    // проходит. Форма с пробелом при этом читается как прежде: там
    // значение отдельным словом, и по имени опции видно, что это.
    assertEquals(
      commandLine(["api", "--limit=10"]),
      "mpu api --limit=REDACTED",
    );
    assertEquals(
      commandLine(["api", "--pasword=hunter2"]),
      "mpu api --pasword=REDACTED",
    );
  });
  await t.step("невалидный JSON не трогается", () => {
    assertEquals(commandLine(["api", "-b", "{oops"]), "mpu api -b '{oops'");
  });
  await t.step("секретов нет — текст дословный, без пересборки", () => {
    assertEquals(
      commandLine(["api", "-b", '{ "a" : 1 }']),
      `mpu api -b '{ "a" : 1 }'`,
    );
  });
  await t.step("@file-индирекция тела не разворачивается", () => {
    assertEquals(
      commandLine(["api", "-b", "@body.json"]),
      "mpu api -b @body.json",
    );
  });
});

Deno.test("строка команды вызова тула MCP-сервером", async (t) => {
  await t.step("путь через пробел и JSON одной строкой", () => {
    assertEquals(
      toolCommandLine(["xlsx", "ls"], { path: "/tmp/a b.xlsx", sheet: 1 }),
      `mpu xlsx ls '{"path":"/tmp/a b.xlsx","sheet":1}'`,
    );
  });
  await t.step("секретные ключи маскируются рекурсивно", () => {
    assertEquals(
      toolCommandLine(["api"], { auth: { token: "x" }, keep: true }),
      `mpu api '{"auth":{"token":"REDACTED"},"keep":true}'`,
    );
  });
  await t.step("аргументов нет — пустой объект", () => {
    assertEquals(toolCommandLine(["version"], {}), `mpu version '{}'`);
  });
  await t.step("аргументы не сериализуемы — литерал null", () => {
    assertEquals(toolCommandLine(["version"], undefined), "mpu version null");
  });
});

Deno.test("маскирование текста JSON — отдельная поверхность", async (t) => {
  await t.step("массив верхнего уровня", () => {
    assertEquals(maskJsonText('[{"token":"x"}]'), '[{"token":"REDACTED"}]');
  });
  await t.step("скаляр верхнего уровня не меняется", () => {
    assertEquals(maskJsonText('"token"'), '"token"');
  });
  await t.step("null-значение секретного ключа тоже маскируется", () => {
    assertEquals(maskJsonText('{"token":null}'), '{"token":"REDACTED"}');
  });
});

Deno.test("помеченная команда: аргументы после пути заменены маской", () => {
  assertEquals(
    commandLine(["telegram", "log", "личная заметка"], {
      path: ["telegram", "log"],
    }),
    "mpu telegram log REDACTED",
  );
});

Deno.test("помеченная команда: маскируется каждый аргумент, не только первый", () => {
  assertEquals(
    commandLine(["telegram", "log", "текст", "--чужое", "значение"], {
      path: ["telegram", "log"],
    }),
    "mpu telegram log REDACTED REDACTED REDACTED",
  );
});

Deno.test("путь команды маской не трогается", () => {
  assertEquals(
    commandLine(["telegram", "log"], { path: ["telegram", "log"] }),
    "mpu telegram log",
  );
});

Deno.test("помеченная команда: путь в argv не сплошной префикс — общий --json между сегментами", () => {
  // `--json` — общий флаг любого уровня (`entrypoint/mod_test.ts`,
  // `xlsx --json alias ls`): у помеченной команды он тоже аргумент, а
  // не часть пути, поэтому граница ищется сопоставлением с путём, а
  // не длиной префикса — иначе замаскировался бы сегмент пути `log`.
  assertEquals(
    commandLine(["telegram", "--json", "log", "текст"], {
      path: ["telegram", "log"],
    }),
    "mpu telegram REDACTED log REDACTED",
  );
});

Deno.test("помеченная команда: слово аргумента совпадает со словом пути — не принимается за путь", () => {
  // Путь уже пройден целиком двумя первыми элементами — второе
  // совпадение с "log" это уже текст заметки, а не сегмент пути.
  assertEquals(
    commandLine(["telegram", "log", "log"], {
      path: ["telegram", "log"],
    }),
    "mpu telegram log REDACTED",
  );
});

Deno.test("без пометки правило прежнее: маскируются только опции-секреты", () => {
  assertEquals(
    commandLine(["telegram", "send", "привет"]),
    "mpu telegram send привет",
  );
});

Deno.test("помеченный тул: JSON аргументов заменён маской целиком", () => {
  assertEquals(
    toolCommandLine(["telegram", "log"], { message: "личное" }, {
      masked: true,
    }),
    "mpu telegram log REDACTED",
  );
});
