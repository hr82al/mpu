/**
 * Исполнитель строк (`docs/specs/platform/line-executor.md`): команда
 * строки исполняется в отдельном процессе, ядро держит пул таких
 * процессов и говорит с ними кадрами.
 */

export { callIo } from "./callio.ts";
export {
  type ExitStatus,
  MarkerDir,
  type Markers,
  NO_MARKERS,
} from "./death.ts";
export {
  type Launcher,
  MemoryLauncher,
  ProcessLauncher,
  type Spawned,
} from "./launch.ts";
export { STOP_GRACE_MS, WorkerStopped } from "./lineworker.ts";
export { DEFAULT_WARM, Workers } from "./pool.ts";
export { serveOne } from "./serve.ts";
export { streamWire } from "./wire.ts";
