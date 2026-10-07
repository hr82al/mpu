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
  },
});
