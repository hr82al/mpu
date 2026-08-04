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
 * реализован командами контракта, `help` — поверхность точки входа,
 * печатающая список из единого реестра (`platform/registry.md`).
 * Однострокў `help` берёт оттуда же, из слепка, — см. `registry/mod.ts`.
 */
const NOT_LEGACY = new Set(["xlsx", "help"]);

const own = new Map<string, string>();
const children = new Map<string, string[]>();
const order: string[] = [];

for (const leaf of tree.commands) {
  const [name, child] = leaf.path;
  if (!order.includes(name)) order.push(name);
  if (child === undefined) own.set(name, leaf.summary);
  else if (!children.get(name)?.includes(child)) {
    children.set(name, [...children.get(name) ?? [], child]);
  }
}

/**
 * Однострока составного имени: перечисление подкоманд, обрезанное по
 * ширине колонки индекса. Полностью его писать нельзя — у `api` 90
 * подкоманд и строка вышла бы в 1700 символов; сколько именно скрыто,
 * видно из счётчика, а весь список — в справке самой команды.
 */
function composeSummary(name: string, children: readonly string[]): string {
  const LIMIT = 64;
  const shown: string[] = [];
  let width = 0;
  for (const child of children) {
    if (shown.length > 0 && width + child.length + 3 > LIMIT) break;
    width += child.length + (shown.length > 0 ? 3 : 0);
    shown.push(child);
  }
  const hidden = children.length - shown.length;
  const tail = hidden > 0 ? ` … (+${hidden})` : "";
  return `${name}: ${shown.join(" | ")}${tail}`;
}

const entries = order.filter((name) => !NOT_LEGACY.has(name)).map((name) => ({
  name,
  // У составного имени своей однострокѝ в слепке нет: её собирает
  // перечисление подкоманд — данные те же, ничего не выдумано.
  summary: own.get(name) ?? composeSummary(name, children.get(name) ?? []),
}));

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
