/**
 * `@mpu/testing/vitest` — области Vitest, которых у него нет готовыми:
 * ресурс на время `describe` (`heldScope`) и поддельные часы до конца
 * `it` (`fakeTimers`). Отдельной точкой от `@mpu/testing`: модуль
 * импортирует `vitest`, а тот грузится только внутри своего раннера.
 */

export { fakeTimers, heldScope } from "./src/scope.ts";
