/**
 * Telegram от имени личного аккаунта: сеанс MTProto и команды поверх
 * него (`docs/specs/platform/telegram-mtproto.md`).
 *
 * Наружу модуль отдаёт команды реестра — сеанс, план и разбор адресата
 * остаются внутренностями. Сверх них наружу выведены конфигурация бота и
 * вызов метода Bot API из `@mpu/telegram` — ими пользуются вопросы
 * владельцу (`../botquestions/`): второй копии правил быть не должно.
 */

export {
  BOT_TIMEOUTS,
  BotCallError,
  type BotEndpoint,
  type BotFailureWords,
  callBot,
  TELEGRAM_API_BASE,
} from "@mpu/telegram";
export { botConfig, type EnvKeys } from "./config.ts";

export { telegramLogCommand } from "./cmd_log.ts";
export { telegramFileCommand } from "./cmd_file.ts";
export { telegramLsCommand } from "./cmd_ls.ts";
export { telegramSearchCommand } from "./cmd_search.ts";
export { telegramSendCommand } from "./cmd_send.ts";
export { telegramStatusCommand } from "./cmd_status.ts";
export { runTelegramLoginStep, telegramLoginCommand } from "./cmd_login.ts";
export { loginFailureReason } from "./login.ts";
