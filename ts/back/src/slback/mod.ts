/**
 * HTTP-обвязка sl-back (`docs/specs/platform/slback-http.md`): адрес,
 * креды, файловый кэш токена и один вызов под ним.
 *
 * Наружу выведены сеанс, классы отказов и разбор входящих значений
 * (адрес, креды, запись кэша, обрезка текста): последними пользуется
 * не только `src/api/`, но и тесты атома — а второй двери в модуль,
 * мимо этого файла, быть не должно. Сборка запроса, подстановка
 * заголовков и чтение файла кэша остаются внутренностями: второго
 * способа их сделать нет.
 */

export {
  ERROR_BODY_LIMIT,
  parseJsonVerbatim,
  RESPONSE_LIMIT,
  SLBACK_TIMEOUT_MS,
  SlbackError,
  truncate,
} from "./client.ts";
export { ENV_FILE_HINT, slbackBaseUrl, slbackCredentials } from "./config.ts";
export {
  type Clock,
  type CredentialOverrides,
  NoAccessTokenError,
  openSlback,
  type SlbackIo,
  type SlbackSession,
} from "./session.ts";
export { cachedToken, TOKEN_TTL_SEC, tokenCacheText } from "./token.ts";
