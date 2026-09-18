/**
 * Сервер строк и запросов `mpu-back` (`docs/specs/platform/back-rpc.md`).
 */

export {
  type BackOptions,
  DEFAULT_BACK_PORT,
  type RunningBack,
  serveBack,
} from "./server.ts";
export { ANSWER_TIMEOUT_MS } from "./line.ts";
export { type BackProcess, runBack } from "./entry.ts";
export type { SnapshotFs } from "./snapshot.ts";
