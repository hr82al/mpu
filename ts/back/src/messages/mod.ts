/**
 * Разбор строки вызова `mpu` в цепочку сообщений
 * (`docs/specs/platform/messages.md`): один шаг — одно сообщение текущему
 * приёмнику и оставшиеся слова.
 */

export type {
  KeyKind,
  KeywordMethod,
  ReceiverDescription,
} from "./receiver.ts";
export {
  type KeyValue,
  type Message,
  MessageParseError,
  StrayWord,
  UNNAMED_REFUSAL,
} from "./message.ts";
export { type MessageStep, readMessage } from "./read.ts";
export { GRAMMAR, HELP_FLAG } from "./words.ts";
export { flagged } from "./grammar.ts";
export {
  type Evaluation,
  type ParsedMessage,
  resolvedMessage,
  type Value,
} from "./value.ts";
