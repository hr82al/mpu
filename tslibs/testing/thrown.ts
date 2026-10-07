/**
 * `@mpu/testing/thrown` — пойманная ошибка для проверок её полей (`thrown`,
 * `rejected`). Отдельной точкой от `@mpu/testing`: модуль импортирует
 * `vitest`, а тот грузится только внутри своего раннера.
 */

export { rejected, thrown } from "./src/thrown.ts";
