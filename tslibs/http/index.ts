/**
 * `@mpu/http` — транспорт HTTP внешних систем mpu: вызов через
 * `node:http`/`node:https` под двумя пределами времени, прокси (явный →
 * окружение → напрямую), редиректы как у `fetch`, причина отказа одной
 * строкой (`ts/docs/specs/platform/loki-http.md`, `platform/tslibs-http.md`).
 *
 * Поверхность библиотеки — всё, что здесь; устройство — `src/`. Описание
 * каждого имени — JSDoc у его определения.
 */

export {
  DEFAULT_TIMEOUTS,
  firstLine,
  type GetOptions,
  HEADERS_TIMEOUT_MS,
  type HttpBytesResponse,
  HttpCallError,
  type HttpResponse,
  httpGet,
  httpGetBytes,
  httpSend,
  type RequestTimeouts,
  type SendOptions,
  TOTAL_TIMEOUT_MS,
} from "./src/call.ts";
export { withoutCredentials } from "./src/credentials.ts";
// Сборщик тела `multipart/form-data` — часть поверхности транспорта:
// потребителей у него двое (вызовы Kaiten с файлами и `sendDocument`
// Bot API).
export {
  buildMultipartBody,
  type MultipartBody,
  type MultipartPart,
} from "./src/multipart.ts";
export type { ProxyEnv } from "./src/route.ts";
