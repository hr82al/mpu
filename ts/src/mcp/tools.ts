/**
 * Проекция реестра команд в тулы профиля (`platform/mcp-server.md`).
 * Профиль — это множество тулов, а не фильтр при вызове: на `/ro`
 * мутирующий тул не зарегистрирован вовсе.
 */

import type { Command } from "../command/mod.ts";

/** Профиль сервера: путь `/ro` или `/rw`. */
export type Profile = "ro" | "rw";

/** JSON Schema как она уходит клиенту. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Тул в ответе `tools/list`. */
export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: { readonly readOnlyHint: boolean };
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
}

/** Тул и команда, которую он исполняет. */
export interface ToolEntry {
  readonly tool: Tool;
  readonly command: Command;
}

/**
 * Инструкции профиля: они не перечисляют тулы, а объясняют, для каких
 * задач их здесь искать. Уходят в `server/discover`, не в `tools/list`.
 */
export const PROFILE_INSTRUCTIONS: Readonly<Record<Profile, string>> = {
  ro: "Читающие операции над данными и инфраструктурой монорепо: " +
    "выборки из баз клиентов, состояние загрузчиков и сервисов, чтение " +
    "таблиц и локальных книг, карточки задач и merge request'ы. Искать " +
    "здесь, когда нужно посмотреть состояние, а не изменить его.",
  rw: "Изменяющие операции над данными и инфраструктурой монорепо: " +
    "запись в таблицы и базы, правка карточек задач и merge request'ов, " +
    "запуск обслуживающих действий, изменение локальных настроек. Искать " +
    "здесь, когда действие меняет состояние, а не только читает его.",
};

/**
 * Тулы профиля в порядке реестра. Порядок и содержимое зависят только
 * от реестра — отсюда побитовое совпадение между вызовами.
 */
export function profileTools(
  commands: readonly Command[],
  profile: Profile,
): readonly ToolEntry[] {
  return commands
    .filter((command) => command.policy === profile)
    .map((command) => ({ tool: toolOf(command), command }));
}

/** Тул профиля по имени; чужого имени в профиле нет. */
export function findTool(
  commands: readonly Command[],
  profile: Profile,
  name: string,
): ToolEntry | undefined {
  return profileTools(commands, profile).find(
    (entry) => entry.tool.name === name,
  );
}

/**
 * Имя тула из пути команды: сегменты соединяются `_`, дефисы внутри
 * сегмента тоже становятся `_`.
 */
export function toolName(path: readonly string[]): string {
  return path.join("_").replaceAll("-", "_");
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
  if (out["type"] === "object") out["additionalProperties"] = false;
  return out;
}

function publishedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publishedValue);
  if (typeof value !== "object" || value === null) return value;
  return publishedSchema({ ...value });
}
