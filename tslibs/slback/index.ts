/**
 * `@mpu/slback` — разговор с sl-back без привязки к рантайму и к слою команд
 * (`ts/docs/specs/platform/tslibs-slback.md`): один вызов под пределом
 * времени, разбор ответа и отказа, получение токена через кэш
 * (`platform/slback-http.md`).
 *
 * Адрес, креды и хранилище кэша токена — портом `SlbackPort`; env-файла и
 * текстов команд здесь нет. Подставной sl-back для тестов —
 * `@mpu/slback/testing`. Описание каждого имени — JSDoc у его определения.
 */

export {
  ERROR_BODY_LIMIT,
  parseJsonVerbatim,
  RESPONSE_LIMIT,
  SLBACK_TIMEOUT_MS,
  SlbackError,
  truncate,
} from "./src/client.ts";
export {
  type Clock,
  type CredentialOverrides,
  NoAccessTokenError,
  openSlback,
  type SlbackCredentials,
  type SlbackPort,
  type SlbackSession,
} from "./src/session.ts";
export { cachedToken, TOKEN_TTL_SEC, tokenCacheText } from "./src/token.ts";
