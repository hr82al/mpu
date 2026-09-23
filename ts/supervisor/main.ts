/**
 * Точка входа `mpu-supervisor` (`deno task supervisor`): единственное, что
 * запускает служба `mpu.service`.
 */

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

function write(file: { writeSync(p: Uint8Array): number }, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += file.writeSync(bytes.subarray(written));
  }
}

if (import.meta.main) {
  const runtimeDir = Deno.env.get("XDG_RUNTIME_DIR");
  Deno.exit(
    await runSupervisor(Deno.args, {
      launcher: SYSTEM_LAUNCHER,
      clock: SYSTEM_CLOCK,
      log: {
        out: (text) => write(Deno.stdout, `${text}\n`),
        err: (text) => write(Deno.stderr, `${text}\n`),
      },
      stdout: (text) => write(Deno.stdout, text),
      onSignal: (signal, handler) => Deno.addSignalListener(signal, handler),
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
