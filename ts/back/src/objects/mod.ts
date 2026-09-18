/**
 * Объекты цепочки сообщений (`docs/specs/platform/objects.md`): исполнение
 * строки вызова, рефлексия, справка, непонятое, замена метода на лету.
 */

export type {
  Args,
  Call,
  Doc,
  Outcome,
  Receiver,
  Report,
  Sent,
  Yields,
} from "./protocol.ts";
export type { Fallback, Method } from "./method.ts";
export { keyword, link, tail, unary } from "./method.ts";
export { DATA } from "./common.ts";
export { type Ending, origin, Shape, type ShapeOptions } from "./shape.ts";
export { Refusal } from "./refusal.ts";
export { type Loader, Replaceable } from "./replaceable.ts";
export { runChain } from "./chain.ts";
