/**
 * Сборка профилей MCP-сервера (`platform/mcp-server.md`). Профиль — это
 * множество тулов, а не фильтр при вызове: на `/ro` мутирующий тул не
 * зарегистрирован вовсе.
 *
 * Что публиковать, решает закрытый список; как выглядит и как
 * исполняется тул — проекция `native_tool.ts`, теперь единственная:
 * маршрута подпроцесса больше нет (порция 97).
 */

import type { Command, Policy } from "../command/mod.ts";
import { asDestructive, type Profile, type ToolEntry } from "./tool.ts";
import { nativeEntry } from "./native_tool.ts";
// Закрытый список публикации читается из канала спецификаций
// напрямую: копия рядом с кодом дала бы второй источник истины и
// тест, стерегущий их совпадение (`docs/CLAUDE.md`). Импорт
// статический — список попадает в бинарь при `deno compile`.
import toolPolicies from "../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};
// Слепок дерева — часть канала: в рантайме он ниоткуда не снимается,
// а незнакомая версия формата отвергается (`platform/registry.md`).

export type {
  JsonSchema,
  Profile,
  Tool,
  ToolCallResult,
  ToolEntry,
} from "./tool.ts";
export { toolName } from "./tool.ts";

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

/** Расхождение объявленной политики с закрытым списком публикации. */
export class ToolPolicyError extends Error {
  override name = "ToolPolicyError";
}

/**
 * Тулы профиля — команды контракта в порядке реестра. Порядок и
 * содержимое зависят только от реестра и закрытого списка публикации,
 * отсюда побитовое совпадение между вызовами. Прежде сюда добавлялись
 * и команды маршрута `legacy` из слепка; маршрут снят целиком порцией
 * 97, и второго источника у списка тулов больше нет.
 *
 * Публикуется не всё дерево: команда, которой нет в закрытом списке,
 * тула не получает (fail-closed). Правило не косметическое — оно
 * решает, увидит ли агент команду вроде `mpu mcp token`, печатающую
 * секрет, или `mpu copy-client`, копирующую клиента.
 */
export function profileTools(
  commands: readonly Command[],
  profile: Profile,
): readonly ToolEntry[] {
  const entries = commands
    .filter((command) => publishedPolicy(command) === profile)
    .map(nativeEntry)
    .map(markDestructive);
  assertDestructivePublished(toolPolicies.destructive, entries, profile);
  return entries;
}

/**
 * Помечает необратимый тул: состав задан секцией `destructive`
 * закрытого списка. Пометка делается здесь, а не в проекциях: обе
 * читают свои источники, а решение «необратим ли эффект» принимает
 * список, и второго места для него быть не должно.
 */
function markDestructive(entry: ToolEntry): ToolEntry {
  if (!toolPolicies.destructive.includes(entry.path.join(" "))) return entry;
  return { ...entry, tool: asDestructive(entry.tool) };
}

/**
 * Имя из секции `destructive`, которого нет среди публикуемых, — ошибка
 * сборки списка, а не молчаливый пропуск: иначе переименование команды
 * тихо снимет подтверждение с необратимого действия.
 *
 * Профиль сужает проверку: секция — подмножество `rw`, и при сборке
 * `ro` спрашивать с неё нечего.
 */
export function assertDestructivePublished(
  destructive: readonly string[],
  entries: readonly ToolEntry[],
  profile: Profile,
): void {
  if (profile !== "rw") return;
  const published = new Set(entries.map((entry) => entry.path.join(" ")));
  const missing = destructive.filter((name) => !published.has(name));
  if (missing.length > 0) {
    throw new ToolPolicyError(
      `секция destructive называет неопубликованные команды: ${
        missing.join(", ")
      }`,
    );
  }
}

/**
 * Профиль команды контракта по закрытому списку; команды нет в списке —
 * она не публикуется. Расхождение политики в коде с политикой списка —
 * отказ собрать тулы, а не молчаливый выбор одной из двух (инвариант
 * спеки).
 */
function publishedPolicy(command: Command): Policy | undefined {
  const name = command.path.join(" ");
  const listed = listedPolicy(name);
  if (listed === undefined) return undefined;
  if (listed !== command.policy) {
    throw new ToolPolicyError(
      `${name}: политика в коде (${command.policy}) расходится ` +
        `с закрытым списком публикации (${listed})`,
    );
  }
  return listed;
}

function listedPolicy(name: string): Policy | undefined {
  if (toolPolicies.ro.includes(name)) return "ro";
  if (toolPolicies.rw.includes(name)) return "rw";
  return undefined;
}

/**
 * Снапшот тулов профиля: тот же текст сверяет инвариант
 * `invariants_test.ts` и пересобирает `deno task tools:snapshot`. Одна
 * функция на оба пути намеренно: разойдись они отступом или хвостовым
 * переводом строки — пересобранный снапшот ронял бы собственный тест.
 */
export function toolsSnapshot(
  commands: readonly Command[],
  profile: Profile,
): string {
  const tools = profileTools(commands, profile).map((entry) => entry.tool);
  return `${JSON.stringify(tools, null, 2)}\n`;
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
