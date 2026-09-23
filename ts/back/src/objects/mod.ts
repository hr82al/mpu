/**
 * Объекты цепочки сообщений (`docs/specs/platform/objects.md`): исполнение
 * строки вызова, рефлексия, справка, непонятое, замена метода на лету.
 */

export type {
  Args,
  Call,
  Doc,
  KeyLine,
  MessageLine,
  Named,
  Outcome,
  Receiver,
  Reflection,
  Refused,
  Remedy,
  Report,
  ResultKind,
  Sent,
  Told,
  Trace,
  ValueEvaluation,
  ValueLine,
  VariantLine,
  Yields,
} from "./protocol.ts";
export type { Description, Fallback, Method, VariantMethod } from "./method.ts";
export {
  AsideCall,
  foreignTail,
  gate,
  keyword,
  link,
  tail,
  unary,
} from "./method.ts";
export { DATA } from "./common.ts";
export {
  type Closing,
  type Ending,
  EVERYONE,
  NO_VALUES,
  origin,
  type Roster,
  Shape,
  type ShapeOptions,
  type Strays,
  type Values,
} from "./shape.ts";
export {
  LISTED,
  messageListing,
  valueListing,
  wordListing,
} from "./reflection.ts";
export { completeLine, type Suggestion } from "./complete.ts";
export { SILENT } from "./silent.ts";
export {
  notUnderstood,
  plainRefusal,
  Refusal,
  Rejection,
  RENAMED,
  UNDERSTOOD_NOT,
  unknownKey,
} from "./refusal.ts";
export {
  atAddress,
  NO_REMEDY,
  ROOT_TEXT,
  throughGate,
  wholeLine,
} from "./remedy.ts";
export { type Loader, Replaceable } from "./replaceable.ts";
export { GroupExit, runChain } from "./chain.ts";
export { keywordSent } from "./sent.ts";
export { ended } from "./result.ts";
export {
  collectionOf,
  type Data,
  isSelection,
  type ListView,
  resultData,
  SELECTABLE,
  selectable,
  selecting,
  selectionMessages,
  selectionOf,
  type Source,
} from "./data.ts";
export { Help, type HelpData } from "./help.ts";
