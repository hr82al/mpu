/**
 * Исполнитель настоящим процессом (`platform/line-executor.md`):
 * обёртка `/bin/sh` ставит `oom_score_adj`, команда исполняется в
 * процессе исполнителя, а не ядра, исполнитель кончается после строки и
 * при закрытом stdin. Программа исполнителя — `back/scripts/worker.sh`
 * (задача `worker` тех же исходников).
 */

import { execFile } from "node:child_process";
import { expect, it } from "vitest";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { NO_PARAMS, TYPED } from "@mpu/language/program";
import { findCommand } from "../registry/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
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
  // Процесса уже нет — `cat` кончается ненулевым кодом с пустым stdout:
  // ответ — пустая строка, а не отказ.
  const stdout = await new Promise<string>((resolve) =>
    execFile("/usr/bin/cat", [`/proc/${pid}/oom_score_adj`], (_failed, out) =>
      resolve(out),
    ),
  );
  return stdout.trim();
}

it("процесс исполнителя: oom_score_adj 1000, конец stdin — выход", async () => {
  const spawned = launcher([]).launch();
  expect(await oomScoreOf(spawned.pid)).toBe("1000");
  // Ядро ушло до строки: исполнитель видит закрытый stdin и кончается сам.
  await spawned.wire.close();
  const lines = spawned.wire.lines()[Symbol.asyncIterator]();
  expect((await lines.next()).done).toBe(true);
  expect(await spawned.status).toStrictEqual({ code: 0, signal: null });
});

it("процесс исполнителя: строка исполнена в чужом pid, после неё — выход", async () => {
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
    expect(
      /^\d{14}$/.test(String(Reflect.get(Object(result), "stamp"))),
      JSON.stringify({ result, diagnosed }),
    ).toBe(true);
    expect(pids.length).toBe(1);
    expect(pids[0]).not.toStrictEqual(process.pid);
    expect(await oomScoreOf(pids[0])).toBe("1000");
  } finally {
    await workers.stop();
  }
  // Исполнитель строки кончился: его pid больше не отвечает.
  expect(await oomScoreOf(pids[0])).toBe("");
  expect(workers.busy()).toBe(0);
});

it("процесс исполнителя: ядро ушло посреди строки — исполнитель кончается сам", async () => {
  const spawned = launcher([]).launch();
  const lines = spawned.wire.lines()[Symbol.asyncIterator]();
  await spawned.wire.send(
    encode({
      run: {
        path: ["confirm"],
        args: [],
        cwd: process.cwd(),
        context: {
          tty: { stdin: false, stdout: false, stderr: false },
          stdinOnRequest: true,
        },
      },
    }),
  );
  // `confirm` просит ввод и ждёт: строка идёт.
  const first = await lines.next();
  expect(workerFrameOf(String(first.value))).toStrictEqual({ stdin: true });
  await spawned.wire.close();
  for (
    let next = await lines.next();
    next.done !== true;
    next = await lines.next()
  ) {
    // Дочитываем то, что исполнитель успел сказать до конца.
  }
  expect(await spawned.status).toStrictEqual({ code: 0, signal: null });
});

it("процесс исполнителя: программа — печать кадрами, команда — строкой ядра", async () => {
  const diagnosed: string[] = [];
  const workers = new Workers({
    launcher: launcher(diagnosed),
    markers: NO_MARKERS,
    warm: 1,
    limit: 1,
    diagnose: (line) => void diagnosed.push(line),
  });
  workers.start();
  const printed: string[] = [];
  const asked: string[][] = [];
  const pids: number[] = [];
  const journal: InvokeJournal = {
    nativeCall: () => {},
    note: () => {},
    executedBy: (pid) => void pids.push(pid),
    log: { begin: () => ({}) as never },
  };
  const { separator: SEP, assign: ASSIGN } = GRAMMAR;
  try {
    const end = await workers.evaluate(
      ["2", "print", SEP, "x", ASSIGN, "jsdate", SEP, "x", "isNil"],
      TYPED,
      NO_PARAMS,
      // Вывод строки, всегда готовый: им вывод программы спрашивает
      // готовность строки.
      makeFakeIo({
        openRemoteOutput: () => ({
          out: () => Promise.resolve(),
          err: () => Promise.resolve(),
          captured: () => "",
        }),
      }),
      { stdout: (text) => void printed.push(text), stderr: () => {} },
      (words) => {
        asked.push([...words]);
        return Promise.resolve({
          data: { stamp: "1" },
          command: null,
          shown: "",
        });
      },
      journal,
      [],
    );
    expect(end, diagnosed.join("\n")).toStrictEqual({
      exit: 0,
      refusal: null,
    });
    expect(printed).toStrictEqual(["2\n", "false\n"]);
    expect(asked).toStrictEqual([["jsdate"]]);
    expect(pids[0]).not.toStrictEqual(process.pid);
    // Исполнитель программы места в пуле не занимал.
    expect(workers.busy()).toBe(0);
  } finally {
    await workers.stop();
  }
});
