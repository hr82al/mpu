/**
 * Сторож памяти живьём (`platform/line-executor.md`, сценарий «строка
 * ест память до порога»): настоящие `/usr/bin/ps`, `/usr/bin/cat` и
 * `/usr/bin/kill`, настоящий потомок, занявший 300 МиБ. Нехватка памяти
 * машины не создаётся — порог нехватки задан параметром так, что
 * памяти «мало» всегда, а порог размера — 100 МиБ. Ядро здесь — процесс
 * теста, исполнитель — его потомок, запущенный тем же рантаймом
 * (`testdata/eater.ts`).
 */

import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTs } from "../../back/src/testing/runts.ts";
import { SYSTEM_PROCS, systemHands, Watchdog } from "./mod.ts";

const MIB = 1024 * 1024;

const EATER = new URL("testdata/eater.ts", import.meta.url).pathname;

it("сторож живьём: потомок в 300 МиБ убит, отметка с его размером", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const eater = spawn(...runTs(EATER), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = once(eater, "exit");
  try {
    // Память занята, когда потомок сказал об этом.
    await once(eater.stdout, "data");
    // Имя процесса — то, что видит `ps`: у рантаймов оно разное (под
    // Node 24 главный поток назван `MainThread`), поэтому берётся у
    // самого потомка, а не угадывается по программе.
    const comm = (await readFile(`/proc/${eater.pid}/comm`, "utf8")).trim();
    const logged: string[] = [];
    await new Watchdog({
      source: SYSTEM_PROCS,
      hands: systemHands(`${dir}/mpu/killed`),
      sleep: () => Promise.resolve(),
      log: { out: () => {}, err: (text) => void logged.push(text) },
      core: () => process.pid,
      comm,
      threshold: () => Infinity,
      minBytes: 100 * MIB,
      intervalMs: 1_000,
    }).tick();
    const [, signal] = await exited;
    expect(signal).toBe("SIGKILL");
    const mib = Number(
      (await readFile(`${dir}/mpu/killed/${eater.pid}`, "utf8")).trim(),
    );
    expect(mib >= 300 && mib < 400, `в отметке ${mib} МиБ`).toBe(true);
    expect(logged.length).toBe(1);
  } finally {
    // Потомок гасится при любом исходе; уже убит сторожем — `kill`
    // отвечает `false`, не исключением.
    eater.kill("SIGKILL");
    await exited;
    await rm(dir, { recursive: true });
  }
});
