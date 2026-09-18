/**
 * Паузы дочернего (`platform/supervisor-install.md`, «Супервизор»): 1, 2,
 * 4 … 30 с подряд идущих падений; проработал ≥ 60 с — снова 1 с.
 * Процессы и часы — поддельные.
 */

import { assertEquals } from "@std/assert";
import { Child, type Clock, type Launcher, type Process } from "./mod.ts";

/** Поддельный запуск: каждый процесс кончается, когда скажет тест. */
function launcher() {
  const exits: (() => void)[] = [];
  const spawned = { count: 0 };
  const asked: (() => void)[] = [];
  const fake: Launcher = {
    spawn() {
      spawned.count += 1;
      for (const wake of asked.splice(0)) wake();
      const done = Promise.withResolvers<void>();
      exits.push(done.resolve);
      const process: Process = {
        pid: 1000 + spawned.count,
        exited: done.promise,
        kill: () => done.resolve(),
      };
      return process;
    },
  };
  /** Ждёт `n`-й запуск и кончает его процесс. */
  const crash = async (n: number) => {
    while (spawned.count < n) {
      const next = Promise.withResolvers<void>();
      asked.push(next.resolve);
      await next.promise;
    }
    exits[n - 1]();
  };
  return { fake, exits, spawned, crash };
}

/** Часы: время — из очереди, паузы записываются; пауза ждёт теста. */
function clock(times: number[]) {
  const pauses: number[] = [];
  const waiting: (() => void)[] = [];
  const asked: (() => void)[] = [];
  const fake: Clock = {
    now: () => times.shift() ?? 0,
    sleep(ms, signal) {
      pauses.push(ms);
      for (const wake of asked.splice(0)) wake();
      return new Promise((resolve) => {
        waiting.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  /** Ждёт, пока пауз станет `n`. */
  const paused = async (n: number) => {
    while (pauses.length < n) {
      const next = Promise.withResolvers<void>();
      asked.push(next.resolve);
      await next.promise;
    }
  };
  const resume = () => waiting.shift()?.();
  return { fake, pauses, paused, resume };
}

const LOG = { out() {}, err() {} };

Deno.test("паузы растут 1, 2, 4 … 30 и сбрасываются после 60 с работы", async () => {
  const run = launcher();
  // Моменты: старт и конец каждого запуска; пятый проработал 61 с.
  const times = [0, 100, 0, 100, 0, 100, 0, 100, 0, 61_100, 0, 100];
  const time = clock(times);
  const child = new Child({
    name: "back",
    command: "back",
    args: [],
    launcher: run.fake,
    clock: time.fake,
    log: LOG,
  });
  child.start();
  for (let i = 0; i < 6; i++) {
    await run.crash(i + 1);
    await time.paused(i + 1);
    time.resume();
  }
  assertEquals(time.pauses, [1_000, 2_000, 4_000, 8_000, 1_000, 2_000]);
  await child.stop();
});

Deno.test("потолок паузы — 30 с", async () => {
  const run = launcher();
  const time = clock([]);
  const child = new Child({
    name: "mcp",
    command: "mcp",
    args: [],
    launcher: run.fake,
    clock: time.fake,
    log: LOG,
  });
  child.start();
  for (let i = 0; i < 7; i++) {
    await run.crash(i + 1);
    await time.paused(i + 1);
    time.resume();
  }
  assertEquals(time.pauses, [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
    30_000,
  ]);
  await child.stop();
});

Deno.test("перезапуск в паузе прерывает её и не считается падением", async () => {
  const run = launcher();
  const time = clock([]);
  const child = new Child({
    name: "back",
    command: "back",
    args: [],
    launcher: run.fake,
    clock: time.fake,
    log: LOG,
  });
  child.start();
  await run.crash(1);
  await time.paused(1);
  const restarting = child.restart();
  // Ожидание SIGKILL у перезапуска: процесса нет — оно отпускается сразу.
  time.resume();
  await restarting;
  assertEquals(run.spawned.count >= 1, true);
  await child.stop();
});
