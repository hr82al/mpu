/** Супервизор `mpu-back` и `mpu-mcp` (`docs/specs/platform/supervisor-install.md`). */

export {
  Child,
  type Clock,
  KILL_AFTER_MS,
  type Launcher,
  type Log,
  type Process,
} from "./child.ts";
export {
  runSupervisor,
  type SupervisorProcess,
  type SupervisorSignal,
  VERSION,
} from "./entry.ts";
export { BACK_PORT, MCP_PORT, Supervisor } from "./supervisor.ts";
export { SYSTEM_CLOCK, SYSTEM_LAUNCHER } from "./system.ts";
export {
  DEFAULT_MIN_BYTES,
  defaultThreshold,
  type Hands,
  MARKLESS_HANDS,
  type Proc,
  processesOf,
  type ProcSource,
  type Snapshot,
  snapshotOf,
  SYSTEM_PROCS,
  systemHands,
  WATCH_INTERVAL_MS,
  Watchdog,
  type WatchdogParts,
  type WatchSetup,
} from "./watchdog.ts";
