/**
 * Исполнитель настоящим процессом (`platform/line-executor.md`):
 * обёртка `/bin/sh` ставит `oom_score_adj`, команда исполняется в
 * процессе исполнителя, а не ядра, исполнитель кончается после строки и
 * при закрытом stdin. Программа исполнителя — `back/scripts/worker.sh`
 * (задача `worker` тех же исходников).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { NO_MARKERS, ProcessLauncher, Workers } from "./mod.ts";
import { encode, workerFrameOf } from "./frames.ts";

const PROGRAM = new URL("../../scripts/worker.sh", import.meta.url).pathname;

const JSDATE = findCommand(["jsdate"]);
if (JSDATE === undefined) throw new Error("в реестре нет jsdate");
const COMMAND = JSDATE;

function launcher(diagnosed: string[]): ProcessLauncher {
  return new ProcessLauncher({
    command: PROGRAM,
    args: [],
    diagnose: (line) => void diagnosed.push(line),
    now: () => Date.now(),
  });
}

async function oomScoreOf(pid: number): Promise<string> {
  const read = await new Deno.Command("/usr/bin/cat", {
    args: [`/proc/${pid}/oom_score_adj`],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(read.stdout).trim();
}

Deno.test("процесс исполнителя: oom_score_adj 1000, конец stdin — выход", async () => {
  const spawned = launcher([]).launch();
  assertEquals(await oomScoreOf(spawned.pid), "1000");
  // Ядро ушло до строки: исполнитель видит закрытый stdin и кончается сам.
  await spawned.wire.close();
  const lines = spawned.wire.lines()[Symbol.asyncIterator]();
  assertEquals((await lines.next()).done, true);
  assertEquals(await spawned.status, { code: 0, signal: null });
});

Deno.test("процесс исполнителя: строка исполнена в чужом pid, после неё — выход", async () => {
  const diagnosed: string[] = [];
  const workers = new Workers({
    launcher: launcher(diagnosed),
    markers: NO_MARKERS,
    warm: 1,
    limit: 2,
    diagnose: (line) => void diagnosed.push(line),
  });
  workers.start();
  const pids: number[] = [];
  const journal: InvokeJournal = {
    nativeCall: () => {},
    note: () => {},
    executedBy: (pid) => void pids.push(pid),
    log: { begin: () => ({}) as never },
  };
  try {
    const result = await workers.invoke(COMMAND, [], makeFakeIo({}), journal);
    assertEquals(
      /^\d{14}$/.test(String(Reflect.get(Object(result), "stamp"))),
      true,
      JSON.stringify({ result, diagnosed }),
    );
    assertEquals(pids.length, 1);
    assertNotEquals(pids[0], Deno.pid);
    assertEquals(await oomScoreOf(pids[0]), "1000");
  } finally {
    await workers.stop();
  }
  // Исполнитель строки кончился: его pid больше не отвечает.
  assertEquals(await oomScoreOf(pids[0]), "");
  assertEquals(workers.busy(), 0);
});

Deno.test("процесс исполнителя: ядро ушло посреди строки — исполнитель кончается сам", async () => {
  const spawned = launcher([]).launch();
  const lines = spawned.wire.lines()[Symbol.asyncIterator]();
  await spawned.wire.send(encode({
    run: {
      path: ["confirm"],
      args: [],
      cwd: Deno.cwd(),
      context: {
        tty: { stdin: false, stdout: false, stderr: false },
        stdinOnRequest: true,
      },
    },
  }));
  // `confirm` просит ввод и ждёт: строка идёт.
  const first = await lines.next();
  assertEquals(workerFrameOf(String(first.value)), { stdin: true });
  await spawned.wire.close();
  for (
    let next = await lines.next();
    next.done !== true;
    next = await lines.next()
  ) {
    // Дочитываем то, что исполнитель успел сказать до конца.
  }
  assertEquals(await spawned.status, { code: 0, signal: null });
});
