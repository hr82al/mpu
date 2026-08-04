import { assertEquals } from "@std/assert";
import { parseEnvFile } from "./format.ts";

Deno.test("разбор golden-примера формата", async () => {
  const sample = await Deno.readTextFile(
    new URL("testdata/sample.env", import.meta.url),
  );
  const golden = JSON.parse(
    await Deno.readTextFile(
      new URL("testdata/sample-parsed.json", import.meta.url),
    ),
  );
  assertEquals(parseEnvFile(sample), golden);
});

Deno.test("разбор: граничные случаи формата", async (t) => {
  const cases: readonly [string, string, Record<string, string>][] = [
    ["строка без = пропускается", "JUST_A_WORD\nA=1\n", { A: "1" }],
    ["пустое имя пропускается", "=value\nA=1\n", { A: "1" }],
    ["# без пробела остаётся в значении", "A=va#lue\n", { A: "va#lue" }],
    ["# после пробела режется", "A=val # хвост\n", { A: "val" }],
    ["одинарные кавычки: # цел", "A='va # lue'\n", { A: "va # lue" }],
    ["двойные кавычки: экранирование не трогаем", 'A="a\\nb"\n', {
      A: "a\\nb",
    }],
    ["незакрытая кавычка — безкавычное значение", "A='abc\n", { A: "'abc" }],
    ["дубликат: побеждает последний", "A=1\nA=2\n", { A: "2" }],
    ["отступ и export", "  export  A = 1 \n", { A: "1" }],
    ["export без пробела не срезается", "exportFOO=1\n", { exportFOO: "1" }],
    ["комментарий с отступом", "   # note\nA=1\n", { A: "1" }],
    ["последняя строка без перевода", "A=1", { A: "1" }],
  ];
  for (const [name, text, expected] of cases) {
    await t.step(name, () => assertEquals(parseEnvFile(text), expected));
  }
});
