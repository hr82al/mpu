/**
 * Пересборка снапшотов публикуемых тулов `src/mcp/testdata/tools-*.json`.
 * Запускать после изменения состава команд реестра или закрытого списка
 * публикации: `bun run tools:snapshot`.
 *
 * Здесь только запись файлов: сам текст снапшота собирает `toolsSnapshot`
 * — та же функция, которой сверяется инвариант `src/mcp/invariants.test.ts`.
 * Своей сборки у скрипта нет намеренно: вторая копия правила разошлась бы
 * с первой, и пересобранный снапшот ронял бы собственный тест.
 */

import { writeFile } from "node:fs/promises";
import { commands } from "../src/registry/mod.ts";
import { type Profile, toolsSnapshot } from "../src/mcp/mod.ts";

const PROFILES: readonly Profile[] = ["ro", "rw"];

for (const profile of PROFILES) {
  const text = toolsSnapshot(commands, profile);
  const target = new URL(
    `../src/mcp/testdata/tools-${profile}.json`,
    import.meta.url,
  );
  await writeFile(target, text);
  console.log(`${profile}: ${JSON.parse(text).length} тулов`);
}
