/**
 * Сторона исполнителя (`platform/line-executor.md`): тест играет ядро —
 * шлёт кадры в `serveOne` проводом в памяти и читает ответные.
 */

import { describe, expect, it } from "vitest";
import { within } from "../backend/testback.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { makeFakeIo } from "../testing/mod.ts";
import { encode, workerFrameOf } from "./frames.ts";
import { serveOne } from "./serve.ts";
import { memoryWires } from "./wire.ts";

it("исполнитель: непонятый кадр ядра — диагностика, строка идёт дальше", async () => {
  const { host, worker } = memoryWires();
  const diagnosed: string[] = [];
  const served = serveOne(worker, makeFakeIo({}), (line) =>
    diagnosed.push(line),
  );
  const lines = host.lines()[Symbol.asyncIterator]();
  const next = async () => workerFrameOf(String((await lines.next()).value));
  await host.send(
    encode({
      run: {
        path: ["confirm"],
        args: [],
        cwd: "/work",
        context: {
          tty: { stdin: false, stdout: false, stderr: false },
          stdinOnRequest: true,
        },
      },
    }),
  );
  expect(await next()).toStrictEqual({ stdin: true });
  await host.send("мусор\n");
  await host.send(encode({ stdin: "данные\n" }));
  // Ввод дошёл: `confirm` печатает его и спрашивает дальше.
  expect(await next()).toStrictEqual({ progress: "данные" });
  expect(diagnosed).toStrictEqual([
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

it("исполнитель программы: печать — out, команды — line, итог — exit", async () => {
  const { host, worker } = memoryWires();
  const served = serveOne(worker, makeFakeIo({}), () => {});
  const lines = host.lines()[Symbol.asyncIterator]();
  const next = async () => workerFrameOf(String((await lines.next()).value));
  const sep = GRAMMAR.separator;
  await host.send(
    encode({
      evaluate: {
        words: ["2", "print", sep, "x", GRAMMAR.assign, "version", sep, "x"],
        methods: [],
        source: null,
        params: null,
      },
    }),
  );
  expect(await next()).toStrictEqual({ out: "2\n" });
  expect(await next()).toStrictEqual({ line: ["version"] });
  await host.send(
    encode({
      lined: { data: "0.1.0", command: null, shown: "0.1.0\n" },
    }),
  );
  expect(await next()).toStrictEqual({ out: "0.1.0\n" });
  expect(await next()).toStrictEqual({ result: { exit: 0, refusal: null } });
  expect((await lines.next()).done).toBe(true);
  await host.close();
  await served;
});

it("исполнитель программы: параметры файла из кадра видит @имя", async () => {
  const { host, worker } = memoryWires();
  const served = serveOne(worker, makeFakeIo({}), () => {});
  const lines = host.lines()[Symbol.asyncIterator]();
  const next = async () => workerFrameOf(String((await lines.next()).value));
  await host.send(
    encode({
      evaluate: {
        words: [`${GRAMMAR.variable}col`, "print"],
        methods: [],
        source: "mpu run: x.mpu col: review",
        params: { col: "review" },
      },
    }),
  );
  expect(await next()).toStrictEqual({ out: "review\n" });
  expect(await next()).toStrictEqual({ result: { exit: 0, refusal: null } });
  await host.close();
  await served;
});

describe("исполнитель программы: отказ называет источник из кадра", () => {
  const cases: readonly (readonly [string | null, string, unknown])[] = [
    [
      null,
      "выражение 1: текст не закрыт: добавь ^ к последнему слову — mpu ^a b^",
      ["^a", "b^"],
    ],
    [
      "stdin",
      "stdin: выражение 1: текст не закрыт: добавь ^ к последнему слову",
      null,
    ],
  ];
  for (const [source, text, hint] of cases) {
    it(String(source), async () => {
      const { host, worker } = memoryWires();
      const served = serveOne(worker, makeFakeIo({}), () => {});
      const lines = host.lines()[Symbol.asyncIterator]();
      await host.send(
        encode({
          evaluate: { words: ["^a", "b"], methods: [], source, params: null },
        }),
      );
      const frame = workerFrameOf(String((await lines.next()).value));
      if (!("result" in frame) || !("exit" in frame.result)) {
        throw new Error(`не итог программы: ${JSON.stringify(frame)}`);
      }
      expect(frame.result.exit).toBe(2);
      expect(frame.result.refusal?.text).toStrictEqual(text);
      expect(frame.result.refusal?.hint).toStrictEqual(hint);
      await host.close();
      await served;
    });
  }
});

it("исполнитель программы: метод образа из кадра — согласие, затем тело", async () => {
  const { host, worker } = memoryWires();
  const served = serveOne(worker, makeFakeIo({}), () => {});
  const lines = host.lines()[Symbol.asyncIterator]();
  const next = async () => workerFrameOf(String((await lines.next()).value));
  await host.send(
    encode({
      evaluate: {
        words: ["kiten", "mine"],
        methods: [
          {
            receiver: ["kiten"],
            name: "mine",
            source: [GRAMMAR.open, "version", GRAMMAR.blockEnd],
          },
        ],
        source: null,
        params: null,
      },
    }),
  );
  expect(await next()).toStrictEqual({ line: ["kiten", "mine"] });
  await host.send(encode({ lined: { data: "", command: null, shown: "" } }));
  expect(await next()).toStrictEqual({ line: ["version"] });
  await host.send(
    encode({
      lined: { data: "0.1.0", command: null, shown: "0.1.0\n" },
    }),
  );
  expect(await next()).toStrictEqual({ out: "0.1.0\n" });
  expect(await next()).toStrictEqual({ result: { exit: 0, refusal: null } });
  await host.close();
  await served;
});

it("исполнитель программы: ядро ушло, пока ждали строку команды, — конец", async () => {
  const { host, worker } = memoryWires();
  const served = serveOne(worker, makeFakeIo({}), () => {});
  const lines = host.lines()[Symbol.asyncIterator]();
  await host.send(
    encode({
      evaluate: {
        words: ["x", GRAMMAR.assign, "version"],
        methods: [],
        source: null,
        params: null,
      },
    }),
  );
  expect(workerFrameOf(String((await lines.next()).value))).toStrictEqual({
    line: ["version"],
  });
  await host.close();
  await within(served, 5_000, "исполнитель кончился без ядра");
});
