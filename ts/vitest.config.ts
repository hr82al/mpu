/**
 * Корневой Vitest рабочей области (`docs/specs/platform/vitest.md`):
 * раннер выбирается именем файла — `*.test.ts` здесь, `*_test.ts` у
 * `deno test` (его `test.exclude` в `deno.jsonc`). У `web/` свой раннер
 * (`deno task web:test`), корневой его не исполняет.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["web/**", "**/node_modules/**", ".deno/**", ".tmp/**"],
    coverage: {
      provider: "istanbul",
      // Только модули, которые загрузили тесты, — затронутые прогоном.
      all: false,
      reporter: ["text"],
    },
  },
});
