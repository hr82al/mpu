/**
 * Объекты цепочки сообщений (`docs/specs/platform/objects.md`): исполнение
 * строки вызова, рефлексия, справка, непонятое, замена метода на лету.
 */

export type { Args, Call, Doc, Outcome, Yields } from "./protocol.ts";
export type { Fallback, Method } from "./method.ts";
export { keyword, link, unary } from "./method.ts";
export { DATA } from "./common.ts";
export { origin, Shape } from "./shape.ts";
export { Refusal } from "./refusal.ts";
export { type Loader, Replaceable } from "./replaceable.ts";
export { runChain } from "./chain.ts";
