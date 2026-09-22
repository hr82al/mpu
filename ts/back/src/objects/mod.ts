/**
 * Объекты цепочки сообщений (`docs/specs/platform/objects.md`): исполнение
 * строки вызова, рефлексия, справка, непонятое, замена метода на лету.
 */

export type {
  Args,
  Call,
  Doc,
  Named,
  Outcome,
  Receiver,
  Remedy,
  Report,
  Sent,
  Trace,
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
  origin,
  type Roster,
  Shape,
  type ShapeOptions,
  type Strays,
} from "./shape.ts";
export { Refusal } from "./refusal.ts";
export { line as callLine, NO_REMEDY, spoken } from "./remedy.ts";
export { type Loader, Replaceable } from "./replaceable.ts";
export { runChain } from "./chain.ts";
export { ended } from "./result.ts";
export { Help, type HelpData } from "./help.ts";
