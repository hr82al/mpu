/**
 * Исполнитель глазами ядра (`platform/line-executor.md`): разговор
 * кадрами с исполнителем по сценарию — тест играет сторону исполнителя.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeTimers } from "../testing/scope.ts";
import { rejected } from "../testing/thrown.ts";
import {
  type Answer,
  type CommandIo,
  VerbatimError,
  VerbatimUsageError,
} from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { NO_PARAMS, TYPED } from "../program/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { MarkerDir, NO_MARKERS } from "./death.ts";
import { LineWorker, STOP_GRACE_MS, WorkerStopped } from "./lineworker.ts";
import { ScriptedWorker } from "./testworker.ts";
import { within } from "../backend/testback.ts";

const JSDATE = findCommand(["jsdate"]);
if (JSDATE === undefined) throw new Error("в реестре нет jsdate");
const COMMAND = JSDATE;

/**
 * Вывод строки, всегда готовый принять следующий кусок: им вывод
 * программы спрашивает готовность строки.
 */
const READY_OUTPUT: Pick<CommandIo, "openRemoteOutput"> = {
  openRemoteOutput: () => ({
    out: () => Promise.resolve(),
    err: () => Promise.resolve(),
    captured: () => "",
  }),
};

/** Журнал, помнящий только pid исполнителя. */
function journal(pids: number[]): InvokeJournal {
  return {
    nativeCall: () => {},
    note: () => {},
    executedBy: (pid) => void pids.push(pid),
    log: { begin: () => ({}) as never },
  };
}

function lineWorker(
  script: ScriptedWorker,
  diagnosed: string[] = [],
  markers = NO_MARKERS,
): LineWorker {
  return new LineWorker(script.spawned, {
    markers,
    diagnose: (line) => void diagnosed.push(line),
  });
}

it("исполнитель: run с контекстом порта, результат — значение, pid — в журнал", async () => {
  const script = new ScriptedWorker(4242);
  const worker = lineWorker(script);
  const pids: number[] = [];
  const io = makeFakeIo({
    cwd: () => "/work",
    stdoutIsTerminal: () => true,
    consoleColumns: () => 80,
    env: (name) => (name === "NO_COLOR" ? "1" : undefined),
  });
  const running = worker.run(COMMAND, ["x"], io, journal(pids));
  expect(await script.next()).toStrictEqual({
    run: {
      path: ["jsdate"],
      args: ["x"],
      cwd: "/work",
      context: {
        tty: { stdin: false, stdout: true, stderr: false, columns: 80 },
        env: { NO_COLOR: "1" },
        stdinOnRequest: true,
      },
    },
  });
  await script.send({ result: { value: { stamp: "20260923120000" } } });
  expect(await running).toStrictEqual({ stamp: "20260923120000" });
  expect(pids).toStrictEqual([4242]);
  // После итога ядро закрывает stdin исполнителя.
  expect(await script.next()).toStrictEqual(undefined);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

describe("исполнитель: отказ команды — тот же класс и текст, падение — сообщение", () => {
  const cases = [
    {
      name: "ошибка ввода",
      result: { code: 2 as const, stderr: "mpu jsdate: лишний аргумент" },
      error: VerbatimUsageError,
    },
    {
      name: "доменная",
      result: { code: 1 as const, stderr: "mpu jsdate: нет данных" },
      error: VerbatimError,
    },
    { name: "падение", result: { crash: "сломалось" }, error: Error },
  ];
  for (const one of cases) {
    it(one.name, async () => {
      const script = new ScriptedWorker(1);
      const worker = lineWorker(script);
      const running = worker.run(COMMAND, [], makeFakeIo(), undefined);
      await script.next();
      await script.send({ result: one.result });
      const err = await rejected(() => running, one.error);
      expect(err.message).toStrictEqual(
        "stderr" in one.result ? one.result.stderr : one.result.crash,
      );
      await script.end({ code: 0, signal: null });
      await worker.exited();
    });
  }
});

it("исполнитель: вопрос задаёт ядро своим портом, ответ — кадром", async () => {
  const script = new ScriptedWorker(1);
  const worker = lineWorker(script);
  const asked: string[] = [];
  const io = makeFakeIo({
    prompt: {
      line: <T>(question: string, answer: Answer<T>) => {
        asked.push(`line ${question}`);
        return Promise.resolve(answer.given("y"));
      },
      secret: <T>(question: string, answer: Answer<T>) => {
        asked.push(`secret ${question}`);
        return Promise.resolve(answer.absent());
      },
      copy: (text) => Promise.resolve(void asked.push(`copy ${text}`)),
    },
  });
  const running = worker.run(COMMAND, [], io, undefined);
  await script.next();
  await script.send({ ask: { kind: "line", text: "Применить? " } });
  expect(await script.next()).toStrictEqual({ answer: "y" });
  await script.send({ ask: { kind: "secret", text: "Пароль: " } });
  expect(await script.next()).toStrictEqual({ answer: null });
  await script.send({ ask: { kind: "copy", text: "текст" } });
  expect(await script.next()).toStrictEqual({ answer: null });
  await script.send({ result: { value: 1 } });
  expect(await running).toBe(1);
  expect(asked).toStrictEqual([
    "line Применить? ",
    "secret Пароль: ",
    "copy текст",
  ]);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

it("исполнитель: ввод — по запросу, вывод, ход и заметки — портам строки", async () => {
  const script = new ScriptedWorker(1);
  const diagnosed: string[] = [];
  const worker = lineWorker(script, diagnosed);
  const seen: string[] = [];
  const decoder = new TextDecoder();
  const io = makeFakeIo({
    readStdin: () => Promise.resolve(new TextEncoder().encode("ввод\n")),
    progress: (line) => void seen.push(`progress ${line}`),
    note: (line) => void seen.push(`note ${line}`),
    openRemoteOutput: () => ({
      out: (chunk) =>
        Promise.resolve(void seen.push(`out ${decoder.decode(chunk)}`)),
      err: (chunk) =>
        Promise.resolve(void seen.push(`err ${decoder.decode(chunk)}`)),
      captured: () => "",
    }),
  });
  const running = worker.run(COMMAND, [], io, undefined);
  await script.next();
  await script.send({ stdin: true });
  expect(await script.next()).toStrictEqual({ stdin: "ввод\n" });
  await script.send({ out: "да" });
  await script.send({ err: "нет" });
  await script.send({ progress: "шаг" });
  await script.send({ note: "повтор" });
  await script.print("чужая печать");
  await script.send({ result: { value: null } });
  expect(await running).toStrictEqual(null);
  expect(seen).toStrictEqual([
    "out да",
    "err нет",
    "progress шаг",
    "note повтор",
  ]);
  expect(diagnosed).toStrictEqual(["[worker 1] чужая печать"]);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

describe("исполнитель: смерть без итога — по отметке сторожа, сигналу или коду", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
  });
  afterAll(() => rm(dir, { recursive: true }));
  const cases = [
    {
      name: "отметка сторожа",
      mark: "900\n",
      startedAt: 0,
      status: { code: 137, signal: "SIGKILL" as const },
      text:
        "mpu-back: строка остановлена: машине не хватает памяти, " +
        "строка заняла 900 МиБ",
    },
    {
      name: "без отметки",
      mark: undefined,
      startedAt: 0,
      status: { code: 137, signal: "SIGKILL" as const },
      text: "mpu-back: исполнитель строки упал (сигнал 9)",
    },
    {
      name: "отметка старше запуска — не его",
      mark: "900\n",
      startedAt: Date.now() + 60_000,
      status: { code: 137, signal: "SIGKILL" as const },
      text: "mpu-back: исполнитель строки упал (сигнал 9)",
    },
    {
      name: "кончился кодом",
      mark: undefined,
      startedAt: 0,
      status: { code: 3, signal: null },
      text: "mpu-back: исполнитель строки упал (код 3)",
    },
  ];
  let pid = 700;
  for (const one of cases) {
    it(one.name, async () => {
      const at = ++pid;
      if (one.mark !== undefined) {
        await writeFile(`${dir}/${at}`, one.mark);
      }
      const script = new ScriptedWorker(at, { startedAt: one.startedAt });
      const worker = lineWorker(script, [], new MarkerDir(dir));
      const running = worker.run(COMMAND, [], makeFakeIo(), undefined);
      await script.next();
      await script.end(one.status);
      const err = await rejected(() => running, VerbatimError);
      expect(err.message).toStrictEqual(one.text);
      await worker.exited();
      // Отметка прочитана и убрана: чужой строке она не достанется.
      expect(
        await stat(`${dir}/${at}`).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    });
  }
});

it("исполнитель: остановка строки — stop, через 5 с SIGTERM, ещё через 5 с SIGKILL", async () => {
  fakeTimers();
  const script = new ScriptedWorker(1, { stubborn: true });
  const worker = lineWorker(script);
  const stopping = new AbortController();
  const io: CommandIo = makeFakeIo({ signal: stopping.signal });
  const running = worker.run(COMMAND, [], io, undefined);
  // Отказ строки ловится сразу: он случается посреди сдвига часов, и
  // ожидание, повешенное после, Vitest счёл бы необработанным отказом.
  const stopped = rejected(() => running, WorkerStopped);
  await script.next();
  stopping.abort();
  expect(await script.next()).toStrictEqual({ stop: true });
  await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
  expect(script.signals).toStrictEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(script.signals).toStrictEqual(["SIGTERM"]);
  await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
  expect(script.signals).toStrictEqual(["SIGTERM", "SIGKILL"]);
  // Смерть от руки ядра — не «упал»: строка кончается своей остановкой.
  await stopped;
  await worker.exited();
});

it("исполнитель: остановленный кончился сам — сигналов нет", async () => {
  fakeTimers();
  const script = new ScriptedWorker(1);
  const worker = lineWorker(script);
  const stopping = new AbortController();
  const running = worker.run(
    COMMAND,
    [],
    makeFakeIo({ signal: stopping.signal }),
    undefined,
  );
  await script.next();
  stopping.abort();
  await script.next();
  await script.send({ result: { crash: "остановлена" } });
  await rejected(() => running, Error, "остановлена");
  await script.end({ code: 0, signal: null });
  await worker.exited();
  await vi.advanceTimersByTimeAsync(3 * STOP_GRACE_MS);
  expect(script.signals).toStrictEqual([]);
});

it("исполнитель: умер, пока человек думает над вопросом, — отказ сразу", async () => {
  const script = new ScriptedWorker(1);
  const worker = lineWorker(script);
  const never = Promise.withResolvers<never>();
  const io = makeFakeIo({
    prompt: {
      line: () => never.promise,
      secret: () => never.promise,
      copy: () => Promise.resolve(),
    },
  });
  const running = worker.run(COMMAND, [], io, undefined);
  await script.next();
  await script.send({ ask: { kind: "line", text: "Применить? " } });
  await script.end({ code: 137, signal: "SIGKILL" });
  await rejected(
    () => within(running, 5_000, "отказ строки по смерти исполнителя"),
    VerbatimError,
    "mpu-back: исполнитель строки упал (сигнал 9)",
  );
  await worker.exited();
});

/** Вывод строки, собранный тестом. */
function collected(into: string[]) {
  return {
    stdout: (text: string) => void into.push(`out:${text}`),
    stderr: (text: string) => void into.push(`err:${text}`),
  };
}

it("исполнитель программы: строка команды — ядру, печать — строке, итог — код", async () => {
  const script = new ScriptedWorker(4);
  const worker = lineWorker(script);
  const printed: string[] = [];
  const sent: string[][] = [];
  const pids: number[] = [];
  const running = worker.evaluate(
    ["x"],
    TYPED,
    NO_PARAMS,
    makeFakeIo({ ...READY_OUTPUT }),
    collected(printed),
    (words) => {
      sent.push([...words]);
      return Promise.resolve({ data: 1, command: null, shown: "1\n" });
    },
    journal(pids),
    [],
  );
  expect(await script.next()).toStrictEqual({
    evaluate: { words: ["x"], methods: [], source: null, params: null },
  });
  await script.send({ line: ["kiten", "ls"] });
  expect(await script.next()).toStrictEqual({
    lined: { data: 1, command: null, shown: "1\n" },
  });
  await script.send({ out: "1\n" });
  await script.send({ err: "ход\n" });
  await script.send({ result: { exit: 0, refusal: null } });
  expect(await within(running, 5_000, "итог программы")).toStrictEqual({
    exit: 0,
    refusal: null,
  });
  expect(sent).toStrictEqual([["kiten", "ls"]]);
  expect(printed).toStrictEqual(["out:1\n", "err:ход\n"]);
  expect(pids).toStrictEqual([4]);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

it("исполнитель программы умер, пока ядро исполняло её команду, — отказ сразу", async () => {
  const script = new ScriptedWorker(5);
  const worker = lineWorker(script);
  const never = Promise.withResolvers<never>();
  const running = worker.evaluate(
    ["x"],
    TYPED,
    NO_PARAMS,
    makeFakeIo({ ...READY_OUTPUT }),
    collected([]),
    () => never.promise,
    journal([]),
    [],
  );
  await script.next();
  await script.send({ line: ["kiten", "ls"] });
  await script.end({ code: 137, signal: "SIGKILL" });
  await rejected(
    () => within(running, 5_000, "отказ по смерти исполнителя программы"),
    VerbatimError,
    "mpu-back: исполнитель строки упал (сигнал 9)",
  );
  await worker.exited();
});

it("исполнитель программы: отмена строки — кадр stop", async () => {
  const script = new ScriptedWorker(6);
  const worker = lineWorker(script);
  const stop = new AbortController();
  const running = worker.evaluate(
    ["x"],
    TYPED,
    NO_PARAMS,
    makeFakeIo({ ...READY_OUTPUT, signal: stop.signal }),
    collected([]),
    () => Promise.resolve({ exit: 1 }),
    journal([]),
    [],
  );
  await script.next();
  stop.abort();
  expect(await script.next()).toStrictEqual({ stop: true });
  await script.send({ result: { exit: 130, refusal: null } });
  expect(
    await within(running, 5_000, "итог отменённой программы"),
  ).toStrictEqual({
    exit: 130,
    refusal: null,
  });
  await script.end({ code: 0, signal: null });
  await worker.exited();
});
