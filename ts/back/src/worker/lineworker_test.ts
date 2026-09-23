/**
 * Исполнитель глазами ядра (`platform/line-executor.md`): разговор
 * кадрами с исполнителем по сценарию — тест играет сторону исполнителя.
 */

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  type Answer,
  type CommandIo,
  VerbatimError,
  VerbatimUsageError,
} from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { findCommand } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { MarkerDir, NO_MARKERS } from "./death.ts";
import { LineWorker, STOP_GRACE_MS, WorkerStopped } from "./lineworker.ts";
import { ScriptedWorker } from "./testworker.ts";
import { within } from "../backend/testback.ts";

const JSDATE = findCommand(["jsdate"]);
if (JSDATE === undefined) throw new Error("в реестре нет jsdate");
const COMMAND = JSDATE;

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

Deno.test("исполнитель: run с контекстом порта, результат — значение, pid — в журнал", async () => {
  const script = new ScriptedWorker(4242);
  const worker = lineWorker(script);
  const pids: number[] = [];
  const io = makeFakeIo({
    cwd: () => "/work",
    stdoutIsTerminal: () => true,
    consoleColumns: () => 80,
    env: (name) => name === "NO_COLOR" ? "1" : undefined,
  });
  const running = worker.run(COMMAND, ["x"], io, journal(pids));
  assertEquals(await script.next(), {
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
  assertEquals(await running, { stamp: "20260923120000" });
  assertEquals(pids, [4242]);
  // После итога ядро закрывает stdin исполнителя.
  assertEquals(await script.next(), undefined);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

Deno.test("исполнитель: отказ команды — тот же класс и текст, падение — сообщение", async (t) => {
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
    await t.step(one.name, async () => {
      const script = new ScriptedWorker(1);
      const worker = lineWorker(script);
      const running = worker.run(COMMAND, [], makeFakeIo(), undefined);
      await script.next();
      await script.send({ result: one.result });
      const err = await assertRejects(() => running);
      assertInstanceOf(err, one.error);
      assertEquals(
        (err as Error).message,
        "stderr" in one.result ? one.result.stderr : one.result.crash,
      );
      await script.end({ code: 0, signal: null });
      await worker.exited();
    });
  }
});

Deno.test("исполнитель: вопрос задаёт ядро своим портом, ответ — кадром", async () => {
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
  assertEquals(await script.next(), { answer: "y" });
  await script.send({ ask: { kind: "secret", text: "Пароль: " } });
  assertEquals(await script.next(), { answer: null });
  await script.send({ ask: { kind: "copy", text: "текст" } });
  assertEquals(await script.next(), { answer: null });
  await script.send({ result: { value: 1 } });
  assertEquals(await running, 1);
  assertEquals(asked, ["line Применить? ", "secret Пароль: ", "copy текст"]);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

Deno.test("исполнитель: ввод — по запросу, вывод, ход и заметки — портам строки", async () => {
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
  assertEquals(await script.next(), { stdin: "ввод\n" });
  await script.send({ out: "да" });
  await script.send({ err: "нет" });
  await script.send({ progress: "шаг" });
  await script.send({ note: "повтор" });
  await script.print("чужая печать");
  await script.send({ result: { value: null } });
  assertEquals(await running, null);
  assertEquals(seen, [
    "out да",
    "err нет",
    "progress шаг",
    "note повтор",
  ]);
  assertEquals(diagnosed, ["[worker 1] чужая печать"]);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

Deno.test("исполнитель: смерть без итога — по отметке сторожа, сигналу или коду", async (t) => {
  const dir = await Deno.makeTempDir();
  try {
    const cases = [
      {
        name: "отметка сторожа",
        mark: "900\n",
        startedAt: 0,
        status: { code: 137, signal: "SIGKILL" as const },
        text: "mpu-back: строка остановлена: машине не хватает памяти, " +
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
      await t.step(one.name, async () => {
        const at = ++pid;
        if (one.mark !== undefined) {
          await Deno.writeTextFile(`${dir}/${at}`, one.mark);
        }
        const script = new ScriptedWorker(at, { startedAt: one.startedAt });
        const worker = lineWorker(script, [], new MarkerDir(dir));
        const running = worker.run(COMMAND, [], makeFakeIo(), undefined);
        await script.next();
        await script.end(one.status);
        const err = await assertRejects(() => running);
        assertInstanceOf(err, VerbatimError);
        assertEquals((err as Error).message, one.text);
        await worker.exited();
        // Отметка прочитана и убрана: чужой строке она не достанется.
        assertEquals(
          await Deno.stat(`${dir}/${at}`).then(() => true, () => false),
          false,
        );
      });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("исполнитель: остановка строки — stop, через 5 с SIGTERM, ещё через 5 с SIGKILL", async () => {
  using time = new FakeTime();
  const script = new ScriptedWorker(1, { stubborn: true });
  const worker = lineWorker(script);
  const stopping = new AbortController();
  const io: CommandIo = makeFakeIo({ signal: stopping.signal });
  const running = worker.run(COMMAND, [], io, undefined);
  await script.next();
  stopping.abort();
  assertEquals(await script.next(), { stop: true });
  await time.tickAsync(STOP_GRACE_MS - 1);
  assertEquals(script.signals, []);
  await time.tickAsync(1);
  assertEquals(script.signals, ["SIGTERM"]);
  await time.tickAsync(STOP_GRACE_MS);
  assertEquals(script.signals, ["SIGTERM", "SIGKILL"]);
  // Смерть от руки ядра — не «упал»: строка кончается своей остановкой.
  const err = await assertRejects(() => running);
  assertInstanceOf(err, WorkerStopped);
  await worker.exited();
});

Deno.test("исполнитель: остановленный кончился сам — сигналов нет", async () => {
  using time = new FakeTime();
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
  await assertRejects(() => running, Error, "остановлена");
  await script.end({ code: 0, signal: null });
  await worker.exited();
  await time.tickAsync(3 * STOP_GRACE_MS);
  assertEquals(script.signals, []);
});

Deno.test("исполнитель: умер, пока человек думает над вопросом, — отказ сразу", async () => {
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
  await assertRejects(
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

Deno.test("исполнитель программы: строка команды — ядру, печать — строке, итог — код", async () => {
  const script = new ScriptedWorker(4);
  const worker = lineWorker(script);
  const printed: string[] = [];
  const sent: string[][] = [];
  const pids: number[] = [];
  const running = worker.evaluate(
    ["x"],
    makeFakeIo({}),
    collected(printed),
    (words) => {
      sent.push([...words]);
      return Promise.resolve({ data: 1, command: null, shown: "1\n" });
    },
    journal(pids),
  );
  assertEquals(await script.next(), { evaluate: { words: ["x"] } });
  await script.send({ line: ["kiten", "ls"] });
  assertEquals(await script.next(), {
    lined: { data: 1, command: null, shown: "1\n" },
  });
  await script.send({ out: "1\n" });
  await script.send({ err: "ход\n" });
  await script.send({ result: { exit: 0, refusal: null } });
  assertEquals(await within(running, 5_000, "итог программы"), {
    exit: 0,
    refusal: null,
  });
  assertEquals(sent, [["kiten", "ls"]]);
  assertEquals(printed, ["out:1\n", "err:ход\n"]);
  assertEquals(pids, [4]);
  await script.end({ code: 0, signal: null });
  await worker.exited();
});

Deno.test("исполнитель программы умер, пока ядро исполняло её команду, — отказ сразу", async () => {
  const script = new ScriptedWorker(5);
  const worker = lineWorker(script);
  const never = Promise.withResolvers<never>();
  const running = worker.evaluate(
    ["x"],
    makeFakeIo({}),
    collected([]),
    () => never.promise,
    journal([]),
  );
  await script.next();
  await script.send({ line: ["kiten", "ls"] });
  await script.end({ code: 137, signal: "SIGKILL" });
  await assertRejects(
    () => within(running, 5_000, "отказ по смерти исполнителя программы"),
    VerbatimError,
    "mpu-back: исполнитель строки упал (сигнал 9)",
  );
  await worker.exited();
});

Deno.test("исполнитель программы: отмена строки — кадр stop", async () => {
  const script = new ScriptedWorker(6);
  const worker = lineWorker(script);
  const stop = new AbortController();
  const running = worker.evaluate(
    ["x"],
    makeFakeIo({ signal: stop.signal }),
    collected([]),
    () => Promise.resolve({ exit: 1 }),
    journal([]),
  );
  await script.next();
  stop.abort();
  assertEquals(await script.next(), { stop: true });
  await script.send({ result: { exit: 130, refusal: null } });
  assertEquals(await within(running, 5_000, "итог отменённой программы"), {
    exit: 130,
    refusal: null,
  });
  await script.end({ code: 0, signal: null });
  await worker.exited();
});
