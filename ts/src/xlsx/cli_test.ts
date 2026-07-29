import { assertEquals, assertThrows } from "@std/assert";
import { lastValue, type OptionSpec, parseOptions } from "./cli.ts";
import { UsageError } from "./errors.ts";

const specs: readonly OptionSpec[] = [
  { long: "file", short: "f", kind: "string" },
  { long: "from", kind: "string" },
  { long: "long", short: "l", kind: "boolean" },
  { long: "json", kind: "boolean" },
];

Deno.test("parseOptions: длинные, короткие, `=`, позиционные", () => {
  const opts = parseOptions(
    ["a", "--file", "f.xlsx", "-l", "--json", "b", "--from=r.txt"],
    specs,
  );
  assertEquals(opts.positional, ["a", "b"]);
  assertEquals(opts.flags.has("long"), true);
  assertEquals(opts.flags.has("json"), true);
  assertEquals(lastValue(opts, "file"), "f.xlsx");
  assertEquals(lastValue(opts, "from"), "r.txt");
  assertEquals(lastValue(opts, "нет"), undefined);
});

Deno.test("parseOptions: повторы строкового флага накапливаются", () => {
  const opts = parseOptions(["--from", "a", "--from", "b"], specs);
  assertEquals(opts.values.get("from"), ["a", "b"]);
  assertEquals(lastValue(opts, "from"), "b");
});

Deno.test("parseOptions: «--» завершает флаги, «-» — позиционный", () => {
  const opts = parseOptions(["-", "--", "--file", "-l"], specs);
  assertEquals(opts.positional, ["-", "--file", "-l"]);
  assertEquals(opts.values.get("file"), undefined);
});

Deno.test("parseOptions: ошибки ввода — UsageError", async (t) => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["неизвестный длинный", ["--nope"]],
    ["неизвестный короткий", ["-x"]],
    ["склейка коротких", ["-lf"]],
    ["строковый без значения", ["--file"]],
    ["булев со значением", ["--json=1"]],
  ];
  for (const [name, args] of cases) {
    await t.step(name, () => {
      assertThrows(() => parseOptions(args, specs), UsageError);
    });
  }
});
