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
