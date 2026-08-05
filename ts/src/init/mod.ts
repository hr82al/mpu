/**
 * Публичная поверхность команды `mpu init` (`docs/specs/init.md`):
 * bootstrap схемы кэш-БД, discovery контейнеров Portainer, прогревы
 * кэшей Loki и Kaiten, вход в Telegram. Маршрут — `native`: команда
 * лежит в реестре (`src/registry/`) и публикуется тулом по закрытому
 * списку.
 */

export { initCommand } from "./cmd_init.ts";
