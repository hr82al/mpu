/**
 * Точка входа `mpu-supervisor` (`bun run supervisor`): единственное, что
 * запускает служба `mpu.service`.
 */

import { writeSync } from "node:fs";
import process from "node:process";
import {
  DEFAULT_MIN_BYTES,
  defaultThreshold,
  MARKLESS_HANDS,
  runSupervisor,
  SYSTEM_CLOCK,
  SYSTEM_LAUNCHER,
  SYSTEM_PROCS,
  systemHands,
  WATCH_INTERVAL_MS,
} from "./src/mod.ts";

const encoder = new TextEncoder();

/** Полная запись в дескриптор: `writeSync` может записать часть. */
function write(fd: number, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes.subarray(written));
  }
}

if (import.meta.main) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  process.exit(
    await runSupervisor(process.argv.slice(2), {
      launcher: SYSTEM_LAUNCHER,
      clock: SYSTEM_CLOCK,
      log: {
        out: (text) => write(1, `${text}\n`),
        err: (text) => write(2, `${text}\n`),
      },
      stdout: (text) => write(1, text),
      onSignal: (signal, handler) => process.on(signal, handler),
      watch: {
        source: SYSTEM_PROCS,
        hands: runtimeDir === undefined || runtimeDir === ""
          ? MARKLESS_HANDS
          : systemHands(`${runtimeDir}/mpu/killed`),
        sleep: SYSTEM_CLOCK.sleep,
        comm: "mpu-worker",
        threshold: defaultThreshold,
        minBytes: DEFAULT_MIN_BYTES,
        intervalMs: WATCH_INTERVAL_MS,
      },
    }),
  );
}
