/**
 * Очередь исполнения (`platform/back-rpc.md`, «Исполнение»): строки
 * исполняются по одной, а строка, ждущая ответа на вопрос, других не
 * держит. Ответа нет 120 секунд — «нет».
 */

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { ANSWER_TIMEOUT_MS } from "./mod.ts";
import { Serial } from "./queue.ts";
import { Client, type TestBack, withBack, within } from "./testback.ts";

/** Строка, чьё исполнение читает файл книги — его задерживает тест. */
const READING = (path: string) => ["xlsx", "ls", "-f", path];

function open(
  back: TestBack,
  words: readonly string[],
  answers: string[] = [],
) {
  const client = new Client(back, "/line", { answers });
  return client.opened().then(() => {
    client.start(words);
    return client;
  });
}

/** Правило `ask` на пути, записанное мимо сервера. */
function askOn(back: TestBack, path: string) {
  using book = RuleBook.open(back.policyFile, []);
  book.set(RulePath.parse(path), ASK);
}

Deno.test("две строки: вторая исполняется после exit первой", async () => {
  using time = new FakeTime();
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const begunB = Promise.withResolvers<void>();
  await withBack(async (back) => {
    const a = await open(back, READING("/a.xlsx"));
    await reading.promise;
    const b = await open(back, READING("/b.xlsx"));
    await begunB.promise;
    // После записи журнала до очереди у строки только микрозадачи:
    // разбор, решение правил, постановка в очередь.
    await time.tickAsync(0);
    events.push("gate");
    gate.resolve();
    await a.finished();
    await b.finished();
    // Исполнение B (чтение книги) — только после того, как A отпустила
    // очередь; при одновременном исполнении B читала бы до ворот.
    assertEquals(events, ["read /a.xlsx", "gate", "read /b.xlsx"]);
  }, {
    io: {
      readFile: async (path) => {
        events.push(`read ${path}`);
        reading.resolve();
        await gate.promise;
        // Пустой файл — не книга: строка кончится ошибкой разбора, код
        // не важен — важен порядок чтений.
        return new Uint8Array();
      },
    },
    begun: (words) => {
      if (words.includes("/b.xlsx")) begunB.resolve();
    },
  });
});

Deno.test("строка, закрытая в очереди, отпускает место следующей", async () => {
  const gate = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const begunB = Promise.withResolvers<void>();
  const reads: string[] = [];
  await withBack(async (back) => {
    const a = await open(back, READING("/a.xlsx"));
    await reading.promise;
    const b = await open(back, READING("/b.xlsx"));
    await begunB.promise;
    b.close();
    await b.closed();
    gate.resolve();
    await a.finished();
    const c = await open(back, ["version"]);
    const frames = await within(c.finished(), 5000, "exit строки C");
    assertEquals(frames.at(-1), { exit: 0 });
    assertEquals(reads, ["/a.xlsx"]);
  }, {
    io: {
      readFile: async (path) => {
        reads.push(path);
        reading.resolve();
        await gate.promise;
        return new Uint8Array();
      },
    },
    begun: (words) => {
      if (words.includes("/b.xlsx")) begunB.resolve();
    },
  });
});

Deno.test("строка, ждущая ответа, не держит другую", async () => {
  await withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    const b = await open(back, ["version"]);
    const bFrames = await within(b.finished(), 5000, "exit строки B");
    assertEquals(bFrames.at(-1), { exit: 0 });
    assertEquals(a.frames.some((frame) => "exit" in frame), false);
    a.answer("y");
    const aFrames = await a.finished();
    assertEquals(aFrames.at(-1), { exit: 0 });
    assertEquals(back.called, ["xlsx alias ls"]);
  });
});

Deno.test("ответа нет 120 секунд — не подтверждено, команда не вызвана", async () => {
  using time = new FakeTime();
  await withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    await time.tickAsync(ANSWER_TIMEOUT_MS - 1);
    assertEquals(a.frames.some((frame) => "exit" in frame), false);
    await time.tickAsync(1);
    assertEquals(await a.finished(), [
      { ask: "выполнить mpu xlsx alias ls? [y/N] " },
      { err: "mpu xlsx alias ls: не подтверждено\n" },
      { exit: 1 },
    ]);
    assertEquals(back.called, []);
  });
});

Deno.test("клиент закрыл сокет, не ответив — исполнения нет", async () => {
  const called: string[][] = [];
  await withBack(async (back) => {
    called.push(back.called);
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    a.close();
    await a.closed();
  });
  // Остановка ждёт строку до конца: к этому месту она доведена.
  assertEquals(called, [[]]);
});

Deno.test("кадр не-ответ после первого игнорируется", async () => {
  await withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    a.send({ words: ["version"] });
    a.send("мусор");
    a.answer("yes");
    const frames = await a.finished();
    assertEquals(frames.at(-1), { exit: 0 });
    assertEquals(back.called, ["xlsx alias ls"]);
  });
});

Deno.test("очередь: второе место — после того, как первое отпущено", async () => {
  const serial = new Serial();
  const events: string[] = [];
  const first = await serial.enter();
  const second = serial.enter().then((slot) => {
    events.push("second");
    return slot;
  });
  await Promise.resolve();
  events.push("leave first");
  first.leave();
  (await second).leave();
  assertEquals(events, ["leave first", "second"]);
});
