/**
 * Поверхность пакета: команды `mpu telegram` — Telegram от имени личного
 * аккаунта поверх сеанса MTProto `@mpu/telegram`
 * (`docs/specs/platform/telegram-mtproto.md`). Наружу — то, что берёт
 * `ts/`: объявления команд (реестр), шаг входа `mpu init` и причина его
 * сбоя. Сверх них — конфигурация бота из env-файла: ею пользуются вопросы
 * владельцу (`@mpu/cmd-botquestions`), второй копии правил быть не
 * должно. Сеанс, план и разбор адресата остаются внутренностями.
 */

export { botConfig, type EnvKeys } from "./src/config.ts";

export { telegramLogCommand } from "./src/cmd_log.ts";
export { telegramFileCommand } from "./src/cmd_file.ts";
export { telegramLsCommand } from "./src/cmd_ls.ts";
export { telegramSearchCommand } from "./src/cmd_search.ts";
export { telegramSendCommand } from "./src/cmd_send.ts";
export { telegramStatusCommand } from "./src/cmd_status.ts";
export {
  runTelegramLoginStep,
  telegramLoginCommand,
} from "./src/cmd_login.ts";
export { loginFailureReason } from "./src/login.ts";
