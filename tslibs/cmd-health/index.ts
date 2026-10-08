/**
 * Поверхность пакета: команда `mpu health` (`docs/specs/health.md`) —
 * состояние `mp-*` контейнеров сервера и хвосты stderr-логов «виновников».
 * Наружу — объявление команды для реестра потребителя.
 */

export { healthCommand } from "./src/cmd_health.ts";
