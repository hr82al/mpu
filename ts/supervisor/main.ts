/**
 * Точка входа `mpu-supervisor` (`deno task supervisor`): единственное, что
 * запускает служба `mpu.service`.
 */

import { runSupervisor, SYSTEM_CLOCK, SYSTEM_LAUNCHER } from "./src/mod.ts";

const encoder = new TextEncoder();

function write(file: { writeSync(p: Uint8Array): number }, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += file.writeSync(bytes.subarray(written));
  }
}

if (import.meta.main) {
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
    }),
  );
}
