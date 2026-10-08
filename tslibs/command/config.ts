/**
 * `@mpu/command/config` — локальные предпочтения CLI и команда
 * `mpu config` (`platform/config.md`). Команда — отдельным реэкспортом:
 * `cmd_config.ts` сам берёт предпочтения из `mod.ts`, и реэкспорт
 * оттуда замкнул бы цикл.
 */

export * from "./src/config/mod.ts";
export { configCommand } from "./src/config/cmd_config.ts";
