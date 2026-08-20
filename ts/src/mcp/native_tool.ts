/**
 * Проекция команды контракта в тул: схемы, описание и исполнение берутся
 * из объявления самой команды (`platform/command-contract.md`).
 */

import type { Command } from "../command/mod.ts";
import type { JsonSchema, Tool, ToolEntry } from "./tool.ts";
import { toolName } from "./tool.ts";

/** Запись тула для команды контракта. */
export function nativeEntry(command: Command): ToolEntry {
  return {
    tool: toolOf(command),
    policy: command.policy,
    path: command.path,
    errorName: command.errorName,
    journal: {
      logsOutput: command.logsOutput,
      logsArguments: command.logsArguments,
      path: command.path,
    },
    invoke: async (args, io) => {
      const result = await command.invokeInput(args, io);
      return {
        isError: false,
        text: JSON.stringify(result),
        structured: result,
      };
    },
  };
}

function toolOf(command: Command): Tool {
  return {
    name: toolName(command.path),
    title: `mpu ${command.path.join(" ")}`,
    // Описание тула и текст `--help` — одно объявление команды: у
    // справки два читателя, и оба читают одни и те же слова.
    description: `${command.summary}\n\n${command.help}`,
    annotations: { readOnlyHint: command.policy === "ro" },
    inputSchema: publishedSchema(command.argsJsonSchema.json),
    outputSchema: publishedSchema(command.resultJsonSchema.json),
  };
}

/**
 * Схема для публикации: без метаключей генератора и с закрытым набором
 * полей на каждом уровне. Закрытость объявлена намеренно — по ней
 * клиент отличает опечатку в имени поля от нового параметра. Обход
 * идёт по всему дереву: `additionalProperties` дописывается каждому
 * узлу-объекту, включая элементы массивов результата.
 */
function publishedSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    out[key] = publishedValue(value);
  }
  // Значение `additionalProperties`, объявленное самой схемой, не
  // трогаем: у открытого словаря (ячейка JSON-типа в результате
  // `sql-ro`) там описание допустимых значений, и закрытие подменило бы
  // его на «полей быть не может» — заведомо ложную схему для агента.
  if (out["type"] === "object" && out["additionalProperties"] === undefined) {
    out["additionalProperties"] = false;
  }
  return out;
}

function publishedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publishedValue);
  if (typeof value !== "object" || value === null) return value;
  return publishedSchema({ ...value });
}
