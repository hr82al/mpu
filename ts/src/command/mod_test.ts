import { assertEquals, assertThrows } from "@std/assert";
import { z } from "@zod/zod";
import { defineCommand } from "./mod.ts";

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
