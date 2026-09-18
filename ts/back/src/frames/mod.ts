/**
 * Контракт кадров строки `mpu-back` (`platform/back-rpc.md`, «Строка»;
 * `fixtures/back-rpc/schema.json`) и версия сборки. Его берут сервер,
 * тонкий клиент (`ts/cli/`) и переводчик (`ts/mcp/`); кроме листа
 * `version.ts`, ничего не импортирует.
 */

export {
  answerOf,
  BadFrame,
  type Collected,
  collectedOf,
  type LineRequest,
  lineRequest,
  type ServerFrame,
  serverFrameOf,
  ticketAnswerOf,
} from "./frame.ts";

export { VERSION } from "../version.ts";
