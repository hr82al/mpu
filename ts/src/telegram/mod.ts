/**
 * Telegram от имени личного аккаунта: сеанс MTProto и команды поверх
 * него (`docs/specs/platform/telegram-mtproto.md`).
 *
 * Наружу модуль отдаёт только команды реестра — сеанс, план и разбор
 * адресата остаются внутренностями.
 */

export { telegramLsCommand } from "./cmd_ls.ts";
export { telegramSearchCommand } from "./cmd_search.ts";
export { telegramSendCommand } from "./cmd_send.ts";
export { telegramStatusCommand } from "./cmd_status.ts";
