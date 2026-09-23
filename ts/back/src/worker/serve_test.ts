/**
 * Сторона исполнителя (`platform/line-executor.md`): тест играет ядро —
 * шлёт кадры в `serveOne` проводом в памяти и читает ответные.
 */

import { assertEquals } from "@std/assert";
import { within } from "../backend/testback.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { encode, workerFrameOf } from "./frames.ts";
import { serveOne } from "./serve.ts";
import { memoryWires } from "./wire.ts";

Deno.test("исполнитель: непонятый кадр ядра — диагностика, строка идёт дальше", async () => {
  const { host, worker } = memoryWires();
  const diagnosed: string[] = [];
  const served = serveOne(
    worker,
    makeFakeIo({}),
    (line) => diagnosed.push(line),
  );
  const lines = host.lines()[Symbol.asyncIterator]();
  const next = async () => workerFrameOf(String((await lines.next()).value));
  await host.send(encode({
    run: {
      path: ["confirm"],
      args: [],
      cwd: "/work",
      context: {
        tty: { stdin: false, stdout: false, stderr: false },
        stdinOnRequest: true,
      },
    },
  }));
  assertEquals(await next(), { stdin: true });
  await host.send("мусор\n");
  await host.send(encode({ stdin: "данные\n" }));
  // Ввод дошёл: `confirm` печатает его и спрашивает дальше.
  assertEquals(await next(), { progress: "данные" });
  assertEquals(diagnosed, [
    "mpu-worker: непонятый кадр ядра: кадр — не объект JSON",
  ]);
  await host.close();
  for (
    let rest = await lines.next();
    rest.done !== true;
    rest = await lines.next()
  ) {
    // Дочитываем то, что исполнитель успел сказать до конца.
  }
  await served;
});

Deno.test("исполнитель программы: печать — out, команды — line, итог — exit", async () => {
  const { host, worker } = memoryWires();
  const served = serveOne(worker, makeFakeIo({}), () => {});
  const lines = host.lines()[Symbol.asyncIterator]();
  const next = async () => workerFrameOf(String((await lines.next()).value));
  const sep = GRAMMAR.separator;
  await host.send(encode({
    evaluate: {
      words: ["2", "print", sep, "x", GRAMMAR.assign, "version", sep, "x"],
    },
  }));
  assertEquals(await next(), { out: "2\n" });
  assertEquals(await next(), { line: ["version"] });
  await host.send(encode({
    lined: { data: "0.1.0", command: null, shown: "0.1.0\n" },
  }));
  assertEquals(await next(), { out: "0.1.0\n" });
  assertEquals(await next(), { result: { exit: 0, refusal: null } });
  assertEquals((await lines.next()).done, true);
  await host.close();
  await served;
});

Deno.test("исполнитель программы: ядро ушло, пока ждали строку команды, — конец", async () => {
  const { host, worker } = memoryWires();
  const served = serveOne(worker, makeFakeIo({}), () => {});
  const lines = host.lines()[Symbol.asyncIterator]();
  await host.send(
    encode({ evaluate: { words: ["x", GRAMMAR.assign, "version"] } }),
  );
  assertEquals(workerFrameOf(String((await lines.next()).value)), {
    line: ["version"],
  });
  await host.close();
  await within(served, 5_000, "исполнитель кончился без ядра");
});
