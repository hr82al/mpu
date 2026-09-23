/**
 * Сторож памяти живьём (`platform/line-executor.md`, сценарий «строка
 * ест память до порога»): настоящие `/usr/bin/ps`, `/usr/bin/cat` и
 * `/usr/bin/kill`, настоящий потомок, занявший 300 МиБ. Нехватка памяти
 * машины не создаётся — порог нехватки задан параметром так, что
 * памяти «мало» всегда, а порог размера — 100 МиБ. Ядро здесь — процесс
 * теста, исполнитель — его потомок `deno`.
 */

import { assertEquals } from "@std/assert";
import { SYSTEM_PROCS, systemHands, Watchdog } from "./mod.ts";

const MIB = 1024 * 1024;

const EATER = `
const eaten = new Uint8Array(300 * 1024 * 1024).fill(1);
console.log("съел", eaten.length);
await new Promise((resolve) => setTimeout(resolve, 60_000));
`;

/** Потомок гасится при любом исходе; уже убит сторожем — гасить нечего. */
function stopEater(eater: Deno.ChildProcess) {
  try {
    eater.kill("SIGKILL");
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
  }
}

Deno.test("сторож живьём: потомок в 300 МиБ убит, отметка с его размером", async () => {
  const dir = await Deno.makeTempDir();
  const eater = new Deno.Command("deno", {
    args: ["eval", EATER],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  try {
    // Память занята, когда потомок сказал об этом.
    const reader = eater.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    const logged: string[] = [];
    await new Watchdog({
      source: SYSTEM_PROCS,
      hands: systemHands(`${dir}/mpu/killed`),
      sleep: () => Promise.resolve(),
      log: { out: () => {}, err: (text) => void logged.push(text) },
      core: () => Deno.pid,
      comm: "deno",
      threshold: () => Infinity,
      minBytes: 100 * MIB,
      intervalMs: 1_000,
    }).tick();
    const status = await eater.status;
    assertEquals(status.signal, "SIGKILL");
    const mib = Number(
      (await Deno.readTextFile(`${dir}/mpu/killed/${eater.pid}`)).trim(),
    );
    assertEquals(mib >= 300 && mib < 400, true, `в отметке ${mib} МиБ`);
    assertEquals(logged.length, 1);
  } finally {
    stopEater(eater);
    await eater.status;
    await eater.stdout.cancel();
    await Deno.remove(dir, { recursive: true });
  }
});
