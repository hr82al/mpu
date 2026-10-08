/**
 * Поверхность пакета: команда `mpu init` (`docs/specs/init.md`) —
 * bootstrap схемы кэш-БД, discovery контейнеров Portainer, прогревы кэшей
 * Loki и Kaiten, вход в Telegram. Маршрут — `native`: команду регистрирует
 * реестр потребителя и публикует тулом по закрытому списку.
 */

export { initCommand } from "./src/cmd_init.ts";
