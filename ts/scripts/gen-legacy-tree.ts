/**
 * Пересборка `src/registry/legacy_tree.ts` из машинного слепка дерева.
 * Запускать после пересъёма слепка: `deno task registry:sync`.
 *
 * Правило сборки однострокѝ намеренно повторено в `tree_test.ts`, а не
 * вынесено в общий модуль: тест обязан выводить ожидание независимо,
 * иначе он повторял бы за генератором его же ошибку.
 */

import tree from "../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

/**
 * Имена, которых в списке маршрута `legacy` быть не должно: `xlsx`
 * реализован командами контракта; `help` и `version` — поверхности
 * точки входа (`platform/registry.md`: список берётся из единого
 * реестра, версия — константа сборки). Однострокѝ обеих берутся из
 * слепка — см. `registry/mod.ts`.
 */
const NOT_LEGACY = new Set(["xlsx", "help", "version"]);

const own = new Map<string, string>();
const order: string[] = [];

for (const node of tree.commands) {
  const [name] = node.path;
  if (!order.includes(name)) order.push(name);
  // Однострока верхнего имени — из его собственной записи: у листа она
  // своя, у группы своя же (слепок v2). Собирать её перечислением
  // подкоманд больше не нужно — источник появился.
  if (node.path.length === 1) own.set(name, node.summary);
}

const entries = order.filter((name) => !NOT_LEGACY.has(name)).map((name) => {
  const summary = own.get(name);
  if (summary === undefined) {
    // Слепок v2 несёт запись каждого узла: пропуск означает, что дамп
    // снят не полностью, и молча подставлять суррогат нельзя.
    throw new Error(`в слепке нет записи верхнего уровня для "${name}"`);
  }
  return { name, summary };
});

const body = entries
  .map((entry) =>
    `  { path: [${JSON.stringify(entry.name)}], ` +
    `summary: ${JSON.stringify(entry.summary)} },`
  )
  .join("\n");

const text = `/**
 * Записи маршрута \`legacy\`, порождённые из машинного слепка дерева
 * (\`docs/specs/fixtures/platform/registry/tree.json\`, mpuVersion
 * ${tree.mpuVersion}). Правка руками недопустима: пересобирается
 * \`deno task registry:sync\`, состав и однострокѝ сверяются со слепком
 * тестом \`tree_test.ts\`.
 *
 * Хранится литералом, а не чтением слепка в рантайме: слепок весит
 * 460 КБ, а быстрый старт — заявленная ценность \`mpu\`. Полное дерево
 * нужно публикации тулов, не маршрутизации (спека).
 */

import type { LegacyCommand } from "../legacy/mod.ts";

/** ${entries.length} команд верхнего уровня, ещё не переехавших на TS. */
export const LEGACY_TREE: readonly LegacyCommand[] = [
${body}
];
`;

const target = new URL("../src/registry/legacy_tree.ts", import.meta.url);
await Deno.writeTextFile(target, text);
console.log(`записей: ${entries.length}`);
