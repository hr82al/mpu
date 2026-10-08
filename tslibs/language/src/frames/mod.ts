/**
 * Контракт кадров строки `mpu-back` (`platform/back-rpc.md`, «Строка»;
 * `fixtures/back-rpc/schema.json`) и контекст вызова
 * (`platform/call-context.md`). Его берут сервер, тонкий клиент
 * (`ts/cli/`) и переводчик (`ts/mcp/`); ничего не импортирует. Версию
 * бинаря (`VERSION`) клиент берёт у `ts/` сам: это факт сборки, а не
 * контракта кадров.
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
  type OutputFile,
  type PictureData,
  type PictureMime,
  pictureOf,
  type RefusalData,
  refusalOf,
  type ServerFrame,
  serverFrameOf,
  STDIN_REQUEST,
  stdinOf,
  ticketAnswerOf,
} from "./frame.ts";

export {
  boundedInput,
  type CallContext,
  callContextOf,
  type CallerFacts,
  CLIENT_ENV_NAMES,
  CONTEXT_IN_ANSWER,
  type ContextFields,
  contextFieldsOf,
  type Environment,
  type EnvRule,
  FRAME_INPUT,
  inputOnRequest,
  type InputSource,
  type LineInput,
  MAX_COLUMNS,
  MAX_STDIN_BYTES,
  MIN_COLUMNS,
  NO_INPUT,
  NOT_TERMINALS,
  SERVER_RULE,
  SESSION_ENV,
  type Terminals,
  tooLargeInput,
} from "./context.ts";

export {
  ASK_WORD,
  hasSeparator,
  isBareLine,
  NotUtf8,
  utf8Of,
  wordsOf,
} from "./words.ts";

export {
  CHANNEL_PATH,
  type ChannelAnswerReader,
  type CoreFrameReader,
  deliveredFrame,
  deliverFrame,
  failedFrame,
  helloFrame,
  helloKeyOf,
  readChannelAnswer,
  readCoreFrame,
  READY_FRAME,
} from "./channel.ts";

export {
  ELICITATION,
  HOOK_LINES,
  HookWords,
  NOTIFICATION,
  PERMISSION_REQUEST,
  PRE_TOOL_USE,
  STOP,
} from "./hook.ts";

export { isRecord, parsedJson } from "./json.ts";
