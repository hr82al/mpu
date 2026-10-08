/**
 * `@mpu/command/testing` — помощники тестов потребителя: подставное io и
 * спрошенный (`mod.ts`), временная кэш-БД и строки SQLite (`cache.ts`),
 * запуск модуля `.ts` текущим рантаймом (`runts.ts`). Программе
 * потребителя не нужны — отдельной точкой. `vitest` вход не тянет: его
 * грузят и генераторы эталонов потребителя, запущенные без Vitest.
 */

export * from "./src/testing/cache.ts";
export * from "./src/testing/mod.ts";
export * from "./src/testing/runts.ts";
