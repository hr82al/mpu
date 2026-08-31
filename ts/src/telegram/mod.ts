/**
 * Telegram от имени личного аккаунта: сеанс MTProto и команды поверх
 * него (`docs/specs/platform/telegram-mtproto.md`).
 *
 * Наружу модуль отдаёт команды реестра — сеанс, план и разбор адресата
 * остаются внутренностями. Сверх них наружу выведена отправка в личного
 * бота: ею пользуется `mpu claude-hook notification`
 * (`docs/specs/claude-hook-notification.md`), и второй копии правил
 * конфигурации и вызова Bot API быть не должно.
 */

export { sendBotMessage } from "./bot.ts";
export { botConfig } from "./bot_config.ts";

export { telegramLogCommand } from "./cmd_log.ts";
export { telegramLsCommand } from "./cmd_ls.ts";
export { telegramSearchCommand } from "./cmd_search.ts";
export { telegramSendCommand } from "./cmd_send.ts";
export { telegramStatusCommand } from "./cmd_status.ts";
export { telegramLoginCommand } from "./cmd_login.ts";
