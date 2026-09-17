/**
 * Проекция команды контракта в тул (`native_tool.ts`): что уходит агенту
 * схемами. Проверяется на синтетическом объявлении, а не на реестре —
 * правило публикации не должно зависеть от того, какие команды сегодня
 * переехали.
 */

import { assertEquals } from "@std/assert";
import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { nativeEntry } from "./native_tool.ts";

const probe = defineCommand({
  path: ["проба"],
  summary: "команда для проверки проекции",
  usage: "mpu проба",
  help: "объявление существует только в этом тесте",
  policy: "ro",
  argsSchema: z.object({ name: z.string().describe("имя") }),
  resultSchema: z.object({
    /** Словарь произвольных ключей: значения описаны схемой. */
    dict: z.record(z.string(), z.string()),
    nested: z.object({ n: z.number().int() }),
  }),
  run: (args) => Promise.resolve({ dict: { a: args.name }, nested: { n: 1 } }),
  render: () => "",
});

const tool = nativeEntry(probe).tool;

Deno.test("схема входа закрыта на каждом уровне", () => {
  assertEquals(tool.inputSchema["additionalProperties"], false);
});

Deno.test("объявленный схемой additionalProperties не подменяется", () => {
  // Закрытие — умолчание публикации, а не переписывание: у словаря
  // произвольных ключей там описание значений, и подмена его на `false`
  // объявила бы агенту словарь, в котором полей быть не может.
  const properties = tool.outputSchema?.["properties"] as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(properties["dict"]["additionalProperties"], { type: "string" });
  // Обычный вложенный объект закрывается, как и корень.
  assertEquals(properties["nested"]["additionalProperties"], false);
  assertEquals(tool.outputSchema?.["additionalProperties"], false);
});
