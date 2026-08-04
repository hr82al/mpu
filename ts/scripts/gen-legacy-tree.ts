/**
 * Пересборка `src/registry/legacy_tree.ts` из машинного слепка дерева.
 * Запускать после пересъёма слепка: `deno task registry:sync`.
 *
 * Здесь только чтение слепка и запись файла: правило порождения записей
 * живёт в `src/registry/tree_source.ts` и проверяется тестами. Раньше
 * оно было тут, и ошибка в нём всплыла бы лишь при следующем пересъёме
 * — скрипт запускается руками и в прогон тестов не попадает.
 */

import { readManifest } from "../src/mcp/legacy_tools.ts";
import { legacyEntriesFrom } from "../src/registry/tree_source.ts";
import tree from "../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

const manifest = readManifest(tree);
const entries = legacyEntriesFrom(manifest);

const body = entries
  .map((entry) =>
    `  { path: ${JSON.stringify(entry.path)}, ` +
    `summary: ${JSON.stringify(entry.summary)} },`
  )
  .join("\n");

const text = `/**
 * Записи маршрута \`legacy\`, порождённые из машинного слепка дерева
 * (\`docs/specs/fixtures/platform/registry/tree.json\`, mpuVersion
 * ${manifest.mpuVersion}). Правка руками недопустима: пересобирается
 * \`deno task registry:sync\`, состав и однострокѝ сверяются со слепком
 * тестом \`tree_test.ts\`.
 *
 * Хранится литералом, а не чтением слепка в рантайме: слепок весит
 * сотни килобайт, а быстрый старт — заявленная ценность \`mpu\`. Полное
 * дерево нужно публикации тулов, не маршрутизации (спека).
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
