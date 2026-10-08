/**
 * Сборка профилей MCP-сервера (`platform/mcp-server.md`). Профиль — это
 * множество тулов, а не фильтр при вызове: на `/ro` мутирующий тул не
 * зарегистрирован вовсе.
 *
 * Что публиковать, решает закрытый список; как выглядит и как
 * исполняется тул — проекция `native_tool.ts`, теперь единственная:
 * маршрута подпроцесса больше нет (порция 97).
 */

import type { Command } from "@mpu/command";
import { asDestructive, type Profile, type ToolEntry } from "./tool.ts";
import { nativeEntry } from "./native_tool.ts";
// Закрытый список публикации приходит от потребителя: он читает его из
// канала спецификаций напрямую, а копия рядом с кодом дала бы второй
// источник истины и тест, стерегущий их совпадение (`docs/CLAUDE.md`).
import type { Publication } from "./publication.ts";
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
  ro:
    "Читающие операции над данными и инфраструктурой монорепо: " +
    "выборки из баз клиентов, состояние загрузчиков и сервисов, чтение " +
    "таблиц и локальных книг, карточки задач и merge request'ы. Искать " +
    "здесь, когда нужно посмотреть состояние, а не изменить его.",
  rw:
    "Изменяющие операции над данными и инфраструктурой монорепо: " +
    "запись в таблицы и базы, правка карточек задач и merge request'ов, " +
    "запуск обслуживающих действий, изменение локальных настроек. Искать " +
    "здесь, когда действие меняет состояние, а не только читает его.",
};

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
  publication: Publication,
): readonly ToolEntry[] {
  const entries = commands
    .filter((command) => publication.policyOf(command) === profile)
    .map(nativeEntry)
    .map((entry) => markDestructive(entry, publication));
  publication.assertDestructivePublished(entries, profile);
  return entries;
}

/**
 * Помечает необратимый тул: состав задан секцией `destructive`
 * закрытого списка. Пометка делается здесь, а не в проекциях: обе
 * читают свои источники, а решение «необратим ли эффект» принимает
 * список, и второго места для него быть не должно.
 */
function markDestructive(
  entry: ToolEntry,
  publication: Publication,
): ToolEntry {
  if (!publication.isDestructive(entry.path.join(" "))) return entry;
  return { ...entry, tool: asDestructive(entry.tool) };
}

/**
 * Снапшот тулов профиля: тот же текст сверяет инвариант потребителя
 * (`ts/back/src/registry/mcp_invariants.test.ts`) и пересобирает
 * `bun run tools:snapshot`. Одна функция на оба пути намеренно:
 * разойдись они отступом или хвостовым переводом строки — пересобранный
 * снапшот ронял бы собственный тест.
 */
export function toolsSnapshot(
  commands: readonly Command[],
  profile: Profile,
  publication: Publication,
): string {
  const tools = profileTools(commands, profile, publication).map(
    (entry) => entry.tool,
  );
  return `${JSON.stringify(tools, null, 2)}\n`;
}

/** Тул профиля по имени; чужого имени в профиле нет. */
export function findTool(
  commands: readonly Command[],
  profile: Profile,
  publication: Publication,
  name: string,
): ToolEntry | undefined {
  return profileTools(commands, profile, publication).find(
    (entry) => entry.tool.name === name,
  );
}
