/**
 * Контракт кадров строки `mpu-back` (`platform/back-rpc.md`, «Строка»;
 * `fixtures/back-rpc/schema.json`). Лист без импортов: его берут и сервер,
 * и тонкий клиент (`ts/cli/`).
 */

export {
  answerOf,
  BadFrame,
  type LineRequest,
  lineRequest,
  type ServerFrame,
  serverFrameOf,
} from "./frame.ts";
