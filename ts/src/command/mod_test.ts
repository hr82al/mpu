import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "@zod/zod";
import { defineCommand, UsageError } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";

/** Минимальное корректное объявление; поля подменяются в тестах. */
function declare(
  overrides: { summary?: string; usage?: string; help?: string },
) {
  return defineCommand({
    path: ["proba"],
    summary: "проба пера",
    usage: "mpu proba",
    help: "Подробности пробы.",
    policy: "ro",
    argsSchema: z.object({}),
    resultSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ ok: true }),
    render: () => "",
    ...overrides,
  });
}

Deno.test("объявление без справочного текста не собирается", async (t) => {
  const cases: readonly (readonly [string, { [k: string]: string }])[] = [
    ["назначение", { summary: "" }],
    ["строка использования", { usage: "" }],
    ["справка", { help: "" }],
    // Пробелы текстом не считаются: индекс родителя останется пустым.
    ["назначение из пробелов", { summary: "   " }],
  ];
  for (const [title, overrides] of cases) {
    await t.step(title, () => {
      assertThrows(
        () => declare(overrides),
        TypeError,
        "текст обязателен",
      );
    });
  }
});

Deno.test("корректное объявление собирается и несёт свои тексты", () => {
  const command = declare({});
  assertEquals(command.path, ["proba"]);
  assertEquals(command.summary, "проба пера");
  assertEquals(command.policy, "ro");
});

Deno.test("вход MCP: не объект — ошибка ввода, а не падение", async (t) => {
  const command = declare({});
  const io = makeFakeIo();
  // Схема сама по себе такой вход отвергла бы невнятно: агенту нужно
  // сообщение про форму аргументов, а не про поля объекта.
  for (const input of [42, "строка", ["массив"], null]) {
    await t.step(JSON.stringify(input) ?? "null", async () => {
      await assertRejects(
        () => command.invokeInput(input, io),
        UsageError,
        "arguments must be an object",
      );
    });
  }
});

Deno.test("разбор argv, давший не объект, — дефект объявления", () => {
  // Схема аргументов, корень которой не объект, до реестра не доходит:
  // её отвергает проверка формы схемы. Здесь — вторая сеть, на случай
  // схемы, чей разбор возвращает не то, что обещал корень.
  const command = defineCommand({
    path: ["proba"],
    summary: "проба пера",
    usage: "mpu proba",
    help: "Подробности пробы.",
    policy: "ro",
    argsSchema: z.object({}).transform(() => "не объект"),
    resultSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ ok: true }),
    render: () => "",
  });
  assertThrows(() => command.parseArgs([]), TypeError, "разбор дал не объект");
});
