/**
 * Vitest библиотеки: тесты `src/*.test.ts` под Bun, Node и Deno
 * (`bun run test:bun`, `test:node`, `test:deno`).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Предела времени нет, как у тестов `ts/`: под нагрузкой машины
    // предел давал ложные красные, а брошенный по пределу случай
    // продолжал исполняться и портил следующий. Свои пределы у вызовов
    // тесты задают сами.
    testTimeout: 0,
    hookTimeout: 0,
    // `zod` — через преобразование Vite, а не родным импортом: под Bun у
    // внешнего модуля пропадает реэкспорт пространства имён (`export { z }`
    // в `zod/index.js`), и `import { z } from "zod"` даёт `undefined` (та
    // же проба, что у `ts/vitest.config.ts`, 2026-10-07).
    server: { deps: { inline: ["zod"] } },
  },
});
