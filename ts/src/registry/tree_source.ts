/**
 * Правило порождения записей реестра из машинного слепка дерева
 * (`platform/registry.md`, «Источник записей реестра»).
 *
 * Живёт в модуле, а не в скрипте синхронизации: скрипт запускается
 * руками после пересъёма слепка, и правило внутри него никакими
 * тестами не проверялось — ошибка всплыла бы только при следующем
 * пересъёме. Теперь скрипт стал тонкой обёрткой над этой функцией:
 * чтение слепка и запись файла, больше ничего.
 */

import type { LegacyCommand } from "../legacy/mod.ts";
import type { Manifest } from "../mcp/legacy_tools.ts";

/**
 * Имена, которых в списке маршрута `legacy` быть не должно: `xlsx`,
 * `init`, `update`, `sql-ro`, `sql` и `logs` реализованы командами
 * контракта; `help` и `version` — поверхности точки входа
 * (`platform/registry.md`).
 */
export const NOT_LEGACY: readonly string[] = [
  "xlsx",
  "init",
  "update",
  "sql-ro",
  "sql",
  "logs",
  "help",
  "version",
];

/** Запись реестра не нашлась в слепке — дамп снят не полностью. */
export class TreeSourceError extends Error {
  override name = "TreeSourceError";
}

/**
 * Записи маршрута `legacy` в порядке слепка. Однострока берётся из
 * записи самогó верхнего имени — у листа своя, у группы своя же
 * (слепок v2); пропуск записи — отказ, а не подстановка суррогата.
 */
export function legacyEntriesFrom(
  manifest: Manifest,
): readonly LegacyCommand[] {
  const own = new Map<string, string>();
  const order: string[] = [];
  for (const node of manifest.commands) {
    const [name] = node.path;
    if (!order.includes(name)) order.push(name);
    if (node.path.length === 1) own.set(name, node.summary);
  }
  return order
    .filter((name) => !NOT_LEGACY.includes(name))
    .map((name) => {
      const summary = own.get(name);
      if (summary === undefined) {
        throw new TreeSourceError(
          `в слепке нет записи верхнего уровня для "${name}"`,
        );
      }
      return { path: [name], summary };
    });
}
