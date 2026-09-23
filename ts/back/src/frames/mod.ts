/**
 * Контракт кадров строки `mpu-back` (`platform/back-rpc.md`, «Строка»;
 * `fixtures/back-rpc/schema.json`) и контекст вызова
 * (`platform/call-context.md`). Его берут сервер, тонкий клиент
 * (`ts/cli/`) и переводчик (`ts/mcp/`); кроме листа `version.ts`,
 * ничего не импортирует.
 */

export { BadFrame } from "./bad.ts";

export {
  answerOf,
  askFrame,
  type AskKind,
  type Collected,
  collectedOf,
  type FirstFrame,
  type LineRequest,
  lineRequest,
  type RefusalData,
  type ServerFrame,
  serverFrameOf,
  ticketAnswerOf,
} from "./frame.ts";

export {
  type CallContext,
  callContextOf,
  type CallerFacts,
  CLIENT_ENV_NAMES,
  CONTEXT_IN_ANSWER,
  type ContextFields,
  contextFieldsOf,
  type Environment,
  type EnvRule,
  type LineInput,
  MAX_COLUMNS,
  MAX_STDIN_BYTES,
  MIN_COLUMNS,
  NO_INPUT,
  NOT_TERMINALS,
  SERVER_RULE,
  type Terminals,
  tooLargeInput,
} from "./context.ts";

export { VERSION } from "../version.ts";
