/**
 * `@mpu/telegram` — разговор с Telegram без привязки к рантайму
 * (`ts/docs/specs/platform/tslibs-telegram.md`): конфигурация сеанса и бота,
 * адресат и его резолв, отправка и поиск поверх порта клиента, вложения
 * входящих сообщений, вызов Bot API.
 *
 * Этот вход лёгкий: клиент MTProto и его wasm сюда не попадают — они за
 * вторым входом `@mpu/telegram/session` (`session.ts`), который потребитель
 * грузит лениво, на ветке, где нужен живой сеанс. Описание каждого имени —
 * JSDoc у его определения.
 */

export type { Attachment } from "./src/attachment.ts";
export { type BotMessage, sendBotMessage } from "./src/bot.ts";
export {
  BOT_TIMEOUTS,
  BotCallError,
  type BotEndpoint,
  type BotFailureWords,
  callBot,
  TELEGRAM_API_BASE,
} from "./src/bot_call.ts";
export { type BotConfig, botConfig } from "./src/bot_config.ts";
export { type Dialog, dedupeById, dialogOf, type RawChat } from "./src/chat.ts";
export type { PeerRef } from "./src/client.ts";
export {
  type EnvKeys,
  type TelegramConfig,
  telegramConfig,
} from "./src/config.ts";
export {
  isLayerError,
  TelegramError,
  TelegramInputError,
} from "./src/errors.ts";
export { Inbox } from "./src/inbox.ts";
export type { AppKeys, LoginClient, LoginPrompts } from "./src/login.ts";
export {
  type FoundMessage,
  foundMessage,
  type RawMessage,
} from "./src/message.ts";
export {
  documentFile,
  type FileClient,
  type MessageFile,
  noFile,
  noMessage,
  photoFile,
  type SavedFile,
} from "./src/message_file.ts";
export {
  EMPTY_TARGET,
  type Peer,
  parsePeer,
  type ResolvablePeer,
} from "./src/peer.ts";
export { parseProxy, type ProxySettings } from "./src/proxy.ts";
export { type PeerResolver, resolveTarget } from "./src/resolve.ts";
export {
  findMessages,
  type PeerTarget,
  SCAN_CAP,
  type SearchClient,
  type SearchPlan,
} from "./src/search.ts";
export { type SendPlan, sendMessage } from "./src/send.ts";
