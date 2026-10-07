/**
 * Сторож памяти (`platform/line-executor.md`, «Защита от нехватки
 * памяти») на поддельных снимках машины; разбор `ps` и `/proc/meminfo` —
 * на образцах, снятых с живой машины (`testdata/watchdog/`: начало
 * вывода `ps` и две его строки — имя с пробелом и `mpu-back`).
 */

import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_MIN_BYTES,
  defaultThreshold,
  type Hands,
  type Proc,
  snapshotOf,
  Watchdog,
} from "./mod.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CORE = 500;

/** Руки, которые только помнят, что их просили сделать. */
function recordingHands(): { hands: Hands; done: string[] } {
  const done: string[] = [];
  return {
    done,
    hands: {
      mark: (pid, mib) => Promise.resolve(void done.push(`mark ${pid} ${mib}`)),
      kill: (pid) => Promise.resolve(void done.push(`kill ${pid}`)),
    },
  };
}

function worker(pid: number, mib: number, ppid = CORE): Proc {
  return { pid, ppid, rss: mib * MIB, comm: "mpu-worker" };
}

/** Такт сторожа над снимком: свободно `available`, всего 16 ГиБ. */
async function tick(
  available: number,
  processes: readonly Proc[],
): Promise<string[]> {
  const { hands, done } = recordingHands();
  const logged: string[] = [];
  await new Watchdog({
    source: {
      read: () => Promise.resolve({ available, total: 16 * GIB, processes }),
    },
    hands,
    sleep: () => Promise.resolve(),
    log: { out: () => {}, err: (text) => void logged.push(text) },
    core: () => CORE,
    comm: "mpu-worker",
    threshold: defaultThreshold,
    minBytes: DEFAULT_MIN_BYTES,
    intervalMs: 1_000,
  }).tick();
  return [...done, ...logged];
}

const LOW = 512 * MIB;
const CORE_PROC: Proc = { pid: CORE, ppid: 1, rss: 4 * GIB, comm: "mpu-back" };

it("сторож: памяти мало — убит самый большой, отметка до убийства", async () => {
  expect(await tick(LOW, [CORE_PROC, worker(601, 300), worker(602, 900)]))
    .toStrictEqual([
      "mark 602 900",
      "kill 602",
      "[supervisor] сторож: памяти 512 МиБ, убит исполнитель 602 (900 МиБ)",
    ]);
});

it("сторож: памяти мало, исполнители не больше 256 МиБ — никого", async () => {
  expect(await tick(LOW, [CORE_PROC, worker(601, 200), worker(602, 256)]))
    .toStrictEqual([]);
});

it("сторож: памяти хватает — никого, даже большого", async () => {
  expect(await tick(2 * GIB, [CORE_PROC, worker(602, 900)])).toStrictEqual([]);
});

it("сторож: не потомок ядра и не исполнитель — не трогается", async () => {
  const stranger = worker(700, 900, 1);
  const grandchild = worker(801, 400, 800);
  const shell: Proc = { pid: 800, ppid: CORE, rss: MIB, comm: "sh" };
  const ssh: Proc = { pid: 900, ppid: CORE, rss: 2 * GIB, comm: "ssh" };
  // Потомок через посредника — исполнитель; порядок строк `ps` любой.
  expect(await tick(LOW, [grandchild, CORE_PROC, stranger, ssh, shell]))
    .toStrictEqual([
      "mark 801 400",
      "kill 801",
      "[supervisor] сторож: памяти 512 МиБ, убит исполнитель 801 (400 МиБ)",
    ]);
});

it("сторож: ядра нет — снимок не снимается", async () => {
  let reads = 0;
  const { hands, done } = recordingHands();
  await new Watchdog({
    source: {
      read: () => {
        reads++;
        return Promise.resolve({ available: 0, total: GIB, processes: [] });
      },
    },
    hands,
    sleep: () => Promise.resolve(),
    log: { out: () => {}, err: () => {} },
    core: () => 0,
    comm: "mpu-worker",
    threshold: defaultThreshold,
    minBytes: DEFAULT_MIN_BYTES,
    intervalMs: 1_000,
  }).tick();
  expect([reads, done]).toStrictEqual([0, []]);
});

it("порог по умолчанию — меньшее из 10 % памяти и 1 ГиБ", () => {
  expect(defaultThreshold(4 * GIB)).toStrictEqual(0.4 * GIB);
  expect(defaultThreshold(32 * GIB)).toStrictEqual(GIB);
});

it("такт упал — строка в лог, сторож живёт до остановки", async () => {
  const stop = new AbortController();
  const logged: string[] = [];
  let reads = 0;
  await new Watchdog({
    source: {
      read: () => {
        if (++reads === 2) stop.abort();
        return Promise.reject(new Error("ps: нет такой программы"));
      },
    },
    hands: recordingHands().hands,
    sleep: () => Promise.resolve(),
    log: { out: () => {}, err: (text) => void logged.push(text) },
    core: () => CORE,
    comm: "mpu-worker",
    threshold: defaultThreshold,
    minBytes: DEFAULT_MIN_BYTES,
    intervalMs: 1_000,
  }).run(stop.signal);
  expect(logged).toStrictEqual([
    "[supervisor] сторож: ps: нет такой программы",
    "[supervisor] сторож: ps: нет такой программы",
  ]);
});

it("снимок из снятых meminfo и ps: байты, имя с пробелом", async () => {
  const dir = new URL("testdata/watchdog/", import.meta.url);
  const snapshot = snapshotOf(
    await readFile(new URL("meminfo.txt", dir), "utf8"),
    await readFile(new URL("ps.txt", dir), "utf8"),
  );
  expect(snapshot.total).toStrictEqual(28470912 * 1024);
  expect(snapshot.available).toStrictEqual(17046576 * 1024);
  expect(snapshot.processes.length).toBe(42);
  expect(snapshot.processes[0]).toStrictEqual({
    pid: 1,
    ppid: 0,
    rss: 13676 * 1024,
    comm: "systemd",
  });
  expect(snapshot.processes.at(-2)?.comm).toBe("tmux: server");
  expect(snapshot.processes.at(-1)).toStrictEqual({
    pid: 1686305,
    ppid: 3358128,
    rss: 192980 * 1024,
    comm: "mpu-back",
  });
});
