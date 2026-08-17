import { assertEquals, assertThrows } from "@std/assert";
import { type InputSpec, parseArgv } from "./args.ts";
import { UsageError } from "./errors.ts";

/** Синтетический набор входов: от конкретных команд тест не зависит. */
const SPECS: readonly InputSpec[] = [
  { name: "file", kind: "string", form: { short: "f" } },
  { name: "from", kind: "strings", form: {} },
  { name: "long", kind: "boolean", form: { short: "l" } },
  { name: "name", kind: "string", form: { positional: "one" } },
  { name: "ranges", kind: "string", form: { positional: "rest" } },
];

const HINT = "mpu proba --help";

function parse(...argv: string[]) {
  return parseArgv(argv, SPECS, HINT);
}

Deno.test("parseArgv: длинные, короткие и запись через «=»", () => {
  assertEquals(parse("--file", "a.xlsx").file, "a.xlsx");
  assertEquals(parse("-f", "b.xlsx").file, "b.xlsx");
  assertEquals(parse("--file=c.xlsx").file, "c.xlsx");
  assertEquals(parse("--long").long, true);
  assertEquals(parse("-l").long, true);
  // Флаг, которого не было в argv, в сыром объекте отсутствует:
  // значение по умолчанию подставляет схема, а не разбор.
  assertEquals("long" in parse(), false);
});

Deno.test("parseArgv: «--no-<имя>» выключает булев вход", async (t) => {
  await t.step("выключает и не путается с включением", () => {
    assertEquals(parse("--no-long").long, false);
    assertEquals(parse("--long", "--no-long").long, false);
    assertEquals(parse("--no-long", "--long").long, true);
  });

  await t.step("отрицается только булев вход", () => {
    // У строкового входа отрицательной формы нет: выключать нечего.
    assertThrows(
      () => parse("--no-file"),
      UsageError,
      'unknown option "--no-file"',
    );
  });

  await t.step("значения отрицательная форма не берёт", () => {
    assertThrows(
      () => parse("--no-long=1"),
      UsageError,
      "option --no-long does not take a value",
    );
  });
});

Deno.test("parseArgv: повторы накапливаются или побеждает последний", () => {
  assertEquals(parse("--from", "a", "--from", "b").from, ["a", "b"]);
  // Строковый вход не накапливается: «последний побеждает».
  assertEquals(parse("-f", "a", "-f", "b").file, "b");
});

Deno.test("parseArgv: позиционные по порядку объявления", () => {
  const parsed = parse("имя", "A1", "B2");
  assertEquals(parsed.name, "имя");
  assertEquals(parsed.ranges, ["A1", "B2"]);
});

Deno.test("parseArgv: «--» завершает флаги, одиночный «-» позиционный", () => {
  const dashed = parse("имя", "--", "--file", "-l");
  assertEquals(dashed.ranges, ["--file", "-l"]);
  assertEquals("file" in dashed, false);
  // «-» — маркер stdin, а не флаг.
  assertEquals(parse("имя", "-").ranges, ["-"]);
});

Deno.test("parseArgv: ошибки ввода — UsageError с подсказкой", async (t) => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    ["неизвестный длинный", ["--nope"], `unknown option "--nope"`],
    ["неизвестный короткий", ["-z"], `unknown option "-z"`],
    ["склейка коротких", ["-lf"], `unknown option "-lf"`],
    ["строковый без значения", ["--file"], "option --file requires a value"],
    ["булев со значением", ["--long=1"], "option --long does not take a value"],
  ];
  for (const [title, argv, message] of cases) {
    await t.step(title, () => {
      const err = assertThrows(
        () => parseArgv(argv, SPECS, HINT),
        UsageError,
        message,
      );
      assertEquals(err.hint, HINT);
    });
  }
});

Deno.test("parseArgv: лишний позиционный без «rest» — ошибка", () => {
  const specs: readonly InputSpec[] = [
    { name: "name", kind: "string", form: { positional: "one" } },
  ];
  const err = assertThrows(
    () => parseArgv(["a", "b"], specs, HINT),
    UsageError,
    `unexpected argument "b"`,
  );
  assertEquals(err.hint, HINT);
});

Deno.test("parseArgv: неопознанные токены — в хвостовой вход", async (t) => {
  // Хвост argv у `mpu ssh` — командная строка для контейнера: её флаги
  // разбирает удалённый шелл, а не мы.
  const specs: readonly InputSpec[] = [
    { name: "via", kind: "string", form: {} },
    { name: "selector", kind: "string", form: { positional: "one" } },
    {
      name: "command",
      kind: "string",
      form: { positional: "rest", keepsUnknown: true },
    },
  ];
  const keep = (...argv: string[]) => parseArgv(argv, specs, HINT);

  await t.step("склейка коротких и необъявленный длинный", () => {
    const parsed = keep("sl-1", "ls", "-la", "--color=always");
    assertEquals(parsed.selector, "sl-1");
    assertEquals(parsed.command, ["ls", "-la", "--color=always"]);
  });

  await t.step("объявленный флаг остаётся флагом и после селектора", () => {
    const parsed = keep("sl-1", "--via", "ssh", "env");
    assertEquals(parsed.via, "ssh");
    assertEquals(parsed.command, ["env"]);
  });

  await t.step("без keepsUnknown правило прежнее", () => {
    assertThrows(() => parse("имя", "-la"), UsageError, 'unknown option "-la"');
  });
});

Deno.test("числовой вход: из argv текст, в аргументах число", async (t) => {
  const specs: readonly InputSpec[] = [
    { name: "jobs", kind: "number", form: { short: "j" } },
    { name: "name", kind: "string", form: { positional: "one" } },
  ];
  const parse = (...argv: string[]) => parseArgv(argv, specs, HINT);

  await t.step("значение забирается как у строкового входа", () => {
    // Разбор argv числа не строит: приведение — работа слоя схемы,
    // которому известен объявленный тип
    // (`platform/command-contract.md`, «Ввод/вывод»).
    assertEquals(parse("--jobs", "2").jobs, "2");
    assertEquals(parse("--jobs=2").jobs, "2");
    assertEquals(parse("-j", "2").jobs, "2");
  });

  await t.step("повтор не накапливается: последний побеждает", () => {
    assertEquals(parse("--jobs", "2", "--jobs", "5").jobs, "5");
  });

  await t.step("значение обязательно", () => {
    assertThrows(
      () => parse("--jobs"),
      UsageError,
      "option --jobs requires a value",
    );
  });
});

Deno.test("числом становится только десятичная запись", async (t) => {
  const specs: readonly InputSpec[] = [
    { name: "tail", kind: "number", form: {} },
  ];
  const parsed = (value: string) =>
    parseArgv(["--tail", value], specs, HINT).tail;

  await t.step("десятичная запись приводится", () => {
    // Само приведение делает слой схемы; здесь видно лишь то, что
    // разбор argv отдаёт значение как есть.
    assertEquals(parsed("50"), "50");
    assertEquals(parsed("-5"), "-5");
    assertEquals(parsed("2.5"), "2.5");
  });

  await t.step("прочие записи числа остаются текстом", () => {
    // Командная строка — не выражение языка: `0x10` это ошибка ввода, а
    // не шестнадцать (`platform/command-contract.md`, «Ввод/вывод»).
    for (const value of ["0x10", "1e3", " 50", "50 ", "Infinity"]) {
      assertEquals(parsed(value), value);
    }
  });
});
