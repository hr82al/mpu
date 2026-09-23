/**
 * Сторож памяти (`platform/line-executor.md`, «Защита от нехватки
 * памяти») на поддельных снимках машины; разбор `ps` и `/proc/meminfo` —
 * на образцах, снятых с живой машины (`testdata/watchdog/`: начало
 * вывода `ps` и две его строки — имя с пробелом и `mpu-back`).
 */

import { assertEquals } from "@std/assert";
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

Deno.test("сторож: памяти мало — убит самый большой, отметка до убийства", async () => {
  assertEquals(
    await tick(LOW, [CORE_PROC, worker(601, 300), worker(602, 900)]),
    [
      "mark 602 900",
      "kill 602",
      "[supervisor] сторож: памяти 512 МиБ, убит исполнитель 602 (900 МиБ)",
    ],
  );
});

Deno.test("сторож: памяти мало, исполнители не больше 256 МиБ — никого", async () => {
  assertEquals(
    await tick(LOW, [CORE_PROC, worker(601, 200), worker(602, 256)]),
    [],
  );
});

Deno.test("сторож: памяти хватает — никого, даже большого", async () => {
  assertEquals(await tick(2 * GIB, [CORE_PROC, worker(602, 900)]), []);
});

Deno.test("сторож: не потомок ядра и не исполнитель — не трогается", async () => {
  const stranger = worker(700, 900, 1);
  const grandchild = worker(801, 400, 800);
  const shell: Proc = { pid: 800, ppid: CORE, rss: MIB, comm: "sh" };
  const ssh: Proc = { pid: 900, ppid: CORE, rss: 2 * GIB, comm: "ssh" };
  // Потомок через посредника — исполнитель; порядок строк `ps` любой.
  assertEquals(
    await tick(LOW, [grandchild, CORE_PROC, stranger, ssh, shell]),
    [
      "mark 801 400",
      "kill 801",
      "[supervisor] сторож: памяти 512 МиБ, убит исполнитель 801 (400 МиБ)",
    ],
  );
});

Deno.test("сторож: ядра нет — снимок не снимается", async () => {
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
  assertEquals([reads, done], [0, []]);
});

Deno.test("порог по умолчанию — меньшее из 10 % памяти и 1 ГиБ", () => {
  assertEquals(defaultThreshold(4 * GIB), 0.4 * GIB);
  assertEquals(defaultThreshold(32 * GIB), GIB);
});

Deno.test("такт упал — строка в лог, сторож живёт до остановки", async () => {
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
  assertEquals(logged, [
    "[supervisor] сторож: ps: нет такой программы",
    "[supervisor] сторож: ps: нет такой программы",
  ]);
});

Deno.test("снимок из снятых meminfo и ps: байты, имя с пробелом", async () => {
  const dir = new URL("testdata/watchdog/", import.meta.url);
  const snapshot = snapshotOf(
    await Deno.readTextFile(new URL("meminfo.txt", dir)),
    await Deno.readTextFile(new URL("ps.txt", dir)),
  );
  assertEquals(snapshot.total, 28470912 * 1024);
  assertEquals(snapshot.available, 17046576 * 1024);
  assertEquals(snapshot.processes.length, 42);
  assertEquals(snapshot.processes[0], {
    pid: 1,
    ppid: 0,
    rss: 13676 * 1024,
    comm: "systemd",
  });
  assertEquals(snapshot.processes.at(-2)?.comm, "tmux: server");
  assertEquals(snapshot.processes.at(-1), {
    pid: 1686305,
    ppid: 3358128,
    rss: 192980 * 1024,
    comm: "mpu-back",
  });
});
