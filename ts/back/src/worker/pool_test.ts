/**
 * Пул исполнителей (`platform/line-executor.md`, «Пул и протокол»):
 * тёплые исполнители, долив после выдачи, предел занятых и отмена
 * ожидания. Настоящая команда — через исполнителя в памяти; разговор с
 * ожиданием — через исполнителей по сценарию.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type Launcher, MemoryLauncher, NO_MARKERS, Workers } from "./mod.ts";
import { ScriptedLauncher, ScriptedWorker } from "./testworker.ts";
import { within } from "../backend/testback.ts";

const JSDATE = findCommand(["jsdate"]);
if (JSDATE === undefined) throw new Error("в реестре нет jsdate");
const COMMAND = JSDATE;

function pool(launcher: Launcher, limit = 4, diagnosed: string[] = []) {
  return new Workers({
    launcher,
    markers: NO_MARKERS,
    warm: 2,
    limit,
    diagnose: (line) => void diagnosed.push(line),
  });
}

Deno.test("пул: тёплые исполнители запущены и остановлены", async () => {
  const launcher = new MemoryLauncher(makeFakeIo({}), 1, () => Date.now());
  const workers = pool(launcher);
  workers.start();
  assertEquals(workers.idle(), 2);
  await workers.stop();
  assertEquals(launcher.launched().length, 2);
});

Deno.test("пул: после строки исполнитель кончился, простаивающих снова 2", async () => {
  const launcher = new MemoryLauncher(makeFakeIo({}), 1, () => Date.now());
  const workers = pool(launcher);
  workers.start();
  const result = await workers.invoke(COMMAND, [], makeFakeIo({}), undefined);
  assertEquals(
    /^\d{14}$/.test(String(Reflect.get(Object(result), "stamp"))),
    true,
  );
  const [first] = launcher.launched();
  await within(first.status, 5_000, "конец исполнителя после строки");
  assertEquals([workers.idle(), launcher.launched().length], [2, 3]);
  await workers.stop();
  assertEquals(workers.busy(), 0);
});

Deno.test("пул: все заняты — строка ждёт, отмена ожидания — сразу", async () => {
  const busy = new ScriptedWorker(1);
  const launcher = new ScriptedLauncher([busy, new ScriptedWorker(2)]);
  const workers = new Workers({
    launcher,
    markers: NO_MARKERS,
    warm: 0,
    limit: 1,
    diagnose: () => {},
  });
  workers.start();
  const first = workers.invoke(COMMAND, [], makeFakeIo({}), undefined);
  await busy.next();
  const stopping = new AbortController();
  const io: CommandIo = makeFakeIo({ signal: stopping.signal });
  const waiting = workers.invoke(COMMAND, [], io, undefined);
  assertEquals([workers.busy(), launcher.launched.length], [1, 1]);
  stopping.abort();
  await assertRejects(() => waiting);
  // Второй исполнитель так и не понадобился.
  assertEquals(launcher.launched.length, 1);
  await busy.send({ result: { value: 1 } });
  assertEquals(await first, 1);
  await busy.end({ code: 0, signal: null });
  await workers.stop();
  assertEquals(workers.busy(), 0);
});

Deno.test("пул: занятый кончился — ждущая строка получает исполнителя", async () => {
  const busy = new ScriptedWorker(1);
  const next = new ScriptedWorker(2);
  const launcher = new ScriptedLauncher([busy, next]);
  const workers = new Workers({
    launcher,
    markers: NO_MARKERS,
    warm: 0,
    limit: 1,
    diagnose: () => {},
  });
  const first = workers.invoke(COMMAND, [], makeFakeIo({}), undefined);
  await busy.next();
  const second = workers.invoke(COMMAND, [], makeFakeIo({}), undefined);
  await busy.send({ result: { value: 1 } });
  assertEquals(await first, 1);
  // Место освобождает конец процесса, а не итог строки.
  assertEquals(launcher.launched.length, 1);
  await busy.end({ code: 0, signal: null });
  await next.next();
  await next.send({ result: { value: 2 } });
  assertEquals(await second, 2);
  await next.end({ code: 0, signal: null });
  await workers.stop();
});

Deno.test("пул: исполнитель не запустился — отказ строки, место свободно", async () => {
  const diagnosed: string[] = [];
  const workers = pool(
    {
      launch: () => {
        throw new Error("нет файла mpu-worker");
      },
    },
    1,
    diagnosed,
  );
  workers.start();
  assertEquals(diagnosed, [
    "mpu-back: исполнитель строки не запустился: нет файла mpu-worker",
  ]);
  await assertRejects(
    () => workers.invoke(COMMAND, [], makeFakeIo({}), undefined),
    Error,
    "mpu-back: исполнитель строки не запустился: нет файла mpu-worker",
  );
  assertEquals(workers.busy(), 0);
  await workers.stop();
});

Deno.test("пул: простаивающий умер сам — ушёл из пула, по кругу не доливается", async () => {
  const dying = new ScriptedWorker(1);
  const launcher = new ScriptedLauncher([dying, new ScriptedWorker(2)]);
  const workers = new Workers({
    launcher,
    markers: NO_MARKERS,
    warm: 1,
    limit: 4,
    diagnose: () => {},
  });
  workers.start();
  await dying.end({ code: 127, signal: null });
  await dying.spawned.status;
  // Обработчики конца идут цепочкой микрозадач: даём им пройти, не
  // засыпая по таймеру.
  for (let turn = 0; turn < 20 && workers.idle() > 0; turn++) {
    await Promise.resolve();
  }
  assertEquals([workers.idle(), launcher.launched.length], [0, 1]);
  await workers.stop();
});
