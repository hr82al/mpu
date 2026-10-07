/**
 * Корневой Vitest рабочей области (`docs/specs/platform/vitest.md`):
 * тесты `*.test.ts` под Bun, Node и Deno (`bun run test`, `test:node`,
 * `test:deno`). У `web/` свой раннер (`bun run web:test`), корневой его
 * не исполняет.
 */

import { defineConfig } from "vitest/config";

/**
 * Случай, чей исход зависит от скорости ответа `back` (дополнение ждёт его
 * 150 мс, `complete/main.ts`), а разбор строки в `back` и без нагрузки
 * стоит 30–60 мс. Рядом с остальными файлами прогона он не успевал
 * (`platform/vitest-v6.md`, [S.6]); отдельной группой он идёт после них,
 * без соседей за процессор. Проверка та же: процесс с правами задачи.
 */
const ALONE = ["complete/src/tasks.test.ts"];

const EXCLUDE = ["web/**", "**/node_modules/**", ".deno/**", ".tmp/**"];

export default defineConfig({
  test: {
    exclude: EXCLUDE,
    // Предела времени нет, как было у `deno test` (`platform/vitest-v2-v5.md`,
    // [S.11]): под нагрузкой 5 с давали ложные красные, а брошенный по
    // пределу случай продолжал исполняться и портил следующий.
    testTimeout: 0,
    hookTimeout: 0,
    // `zod` — через преобразование Vite, а не родным импортом: под Bun у
    // внешнего модуля пропадает реэкспорт пространства имён (`export { z }`
    // в `zod/index.js`), и `import { z } from "zod"` даёт `undefined`
    // (проба 2026-10-07: у простого `bun` — есть, у Vitest под Bun — нет,
    // инлайн и `vmForks` чинят). Под Node и Deno исход тот же.
    server: { deps: { inline: ["zod"] } },
    coverage: {
      provider: "istanbul",
      // Только модули, которые загрузили тесты, — затронутые прогоном.
      all: false,
      reporter: ["text"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "все",
          include: ["**/*.test.ts"],
          exclude: [...EXCLUDE, ...ALONE],
        },
      },
      {
        extends: true,
        test: {
          name: "одни",
          include: ALONE,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
