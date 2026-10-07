/**
 * sl-back для слоя команд (`docs/specs/platform/slback-http.md`): адрес и
 * креды из env-файла (`./config.ts`) и сеанс над io команды
 * (`./session.ts`). Вызов, отказы, токен и подставной sl-back тестов —
 * библиотека `@mpu/slback` (`docs/specs/platform/tslibs-slback.md`).
 */

export { ENV_FILE_HINT, slbackBaseUrl, slbackCredentials } from "./config.ts";
export { openSlback, type SlbackIo } from "./session.ts";
