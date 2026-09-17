import { assertEquals, assertThrows } from "@std/assert";
import { assignEnvValue, EnvValueError, parseEnvFile } from "./format.ts";

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

Deno.test("запись: golden-пример замены и дописывания", async () => {
  const before = await Deno.readTextFile(
    new URL("testdata/write-before.env", import.meta.url),
  );
  const after = await Deno.readTextFile(
    new URL("testdata/write-after.env", import.meta.url),
  );
  const step1 = assignEnvValue(before, "TARGET", "new value with space");
  assertEquals(assignEnvValue(step1, "APPENDED", "bare-token"), after);
});

Deno.test("запись: форма значения и граничные случаи", async (t) => {
  const cases: readonly [string, string, string, string, string][] = [
    ["простое — без кавычек", "", "A", "bare-token", "A=bare-token\n"],
    ["пустое — в кавычках", "", "A", "", "A=''\n"],
    ["с решёткой — в кавычках", "", "A", "a#b", "A='a#b'\n"],
    ["с двойной кавычкой — в одинарных", "", "A", 'a"b', `A='a"b'\n`],
    ["файл без перевода в конце", "A=1", "B", "2", "A=1\nB=2\n"],
    [
      "отступ и export у заменяемой строки",
      "  export A=1\n",
      "A",
      "2",
      "A=2\n",
    ],
    ["похожее имя не трогается", "AB=1\n", "A", "2", "AB=1\nA=2\n"],
    [
      "дубликат строк ключа — меняется только первая",
      "A=1\nA=2\n",
      "A",
      "3",
      "A=3\nA=2\n",
    ],
  ];
  for (const [name, text, key, value, expected] of cases) {
    await t.step(
      name,
      () => assertEquals(assignEnvValue(text, key, value), expected),
    );
  }
});

Deno.test("запись: непригодное значение — ошибка, текст не построен", async (t) => {
  for (
    const [name, value] of [["перевод строки", "a\nb"], ["кавычка", "a'b"]]
  ) {
    await t.step(name, () => {
      assertThrows(() => assignEnvValue("A=1\n", "A", value), EnvValueError);
    });
  }
});

Deno.test("запись: значение читается обратно и идемпотентна", () => {
  const text = assignEnvValue("KEEP=1\n", "A", "value with space");
  assertEquals(parseEnvFile(text)["A"], "value with space");
  assertEquals(assignEnvValue(text, "A", "value with space"), text);
});
