/**
 * Сборка профилей MCP-сервера (`platform/mcp-server.md`). Профиль — это
 * множество тулов, а не фильтр при вызове: на `/ro` мутирующий тул не
 * зарегистрирован вовсе.
 *
 * Что публиковать, решает закрытый список; как выглядит и как
 * исполняется тул — проекции: `native_tool.ts` для команд контракта,
 * `legacy_tools.ts` для команд, исполняемых подпроцессом.
 */

import type { Command, Policy } from "../command/mod.ts";
import type { Profile, ToolEntry } from "./tool.ts";
import { nativeEntry } from "./native_tool.ts";
import { legacyEntry, type LegacyLeaf, readManifest } from "./legacy_tools.ts";
// Закрытый список публикации читается из канала спецификаций
// напрямую: копия рядом с кодом дала бы второй источник истины и
// тест, стерегущий их совпадение (`docs/CLAUDE.md`). Импорт
// статический — список попадает в бинарь при `deno compile`.
import toolPolicies from "../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};
// Слепок дерева — часть канала: в рантайме он ниоткуда не снимается,
// а незнакомая версия формата отвергается (`platform/registry.md`).
import treeManifest from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

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
 * Тулы профиля: сперва команды контракта в порядке реестра, затем
 * команды маршрута `legacy` в порядке слепка. Порядок и содержимое
 * зависят только от этих двух источников — отсюда побитовое совпадение
 * между вызовами.
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
  const native = commands
    .filter((command) => publishedPolicy(command) === profile)
    .map(nativeEntry);
  const published = new Set(native.map((entry) => entry.path.join(" ")));
  const legacy = publishableLegacy(legacyLeaves(), profile, published)
    .map((leaf) => legacyEntry(leaf, profile));
  return [...native, ...legacy];
}

/**
 * Узлы слепка, публикуемые в профиле. Правило вынесено из сборки, чтобы
 * проверяться отдельно от текущего содержимого списка: сегодня групп в
 * списке нет, но правка списка не должна молча сделать группу тулом.
 *
 * Группа отсеивается раньше списка: исполнять у неё нечего, и её
 * присутствие в списке — ошибка списка, а не повод собрать тул
 * (`platform/mcp-server.md`).
 */
export function publishableLegacy(
  nodes: readonly LegacyLeaf[],
  profile: Profile,
  alreadyPublished: ReadonlySet<string> = new Set(),
): readonly LegacyLeaf[] {
  return nodes.filter((node) => {
    if (node.group === true) return false;
    const name = node.path.join(" ");
    return !alreadyPublished.has(name) && listedPolicy(name) === profile;
  });
}

/** Листья слепка в его порядке; версия формата проверяется при чтении. */
function legacyLeaves(): readonly LegacyLeaf[] {
  return readManifest(treeManifest).commands;
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
