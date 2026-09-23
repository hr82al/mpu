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
  Remedy,
  Report,
  Sent,
  Trace,
  ValueEvaluation,
  ValueLine,
  Yields,
} from "./protocol.ts";
export type { Fallback, Method } from "./method.ts";
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
export { Refusal, Rejection } from "./refusal.ts";
export { line as callLine, NO_REMEDY, spoken } from "./remedy.ts";
export { type Loader, Replaceable } from "./replaceable.ts";
export { GroupExit, runChain } from "./chain.ts";
export { ended } from "./result.ts";
export { Help, type HelpData } from "./help.ts";
