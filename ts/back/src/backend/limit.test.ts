/**
 * Предел одновременности строк (`platform/line-concurrency.md`): строки
 * идут разом, место в пределе держит сама строка, а ждущая ответа
 * человека места не занимает вовсе. Ответа нет 120 секунд — «нет».
 */

import { expect, it, vi } from "vitest";
import { fakeTimers } from "@mpu/testing/vitest";
import { ASK, NOT_CONFIRMED, RuleBook, RulePath } from "@mpu/command/policy";
import { ANSWER_TIMEOUT_MS } from "./mod.ts";
import { Lines } from "./limit.ts";
import {
  Client,
  refusalFrame,
  type TestBack,
  withBack,
  within,
} from "./testback.ts";

/** Строка, чьё исполнение читает файл книги — его задерживает тест. */
const READING = (path: string) => ["xlsx", "ls", "file:", path];

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

/**
 * Ожидание начала записи журнала: сервер начинает её до места в
 * пределе, поэтому по ней видно, что строка дошла и именно ждёт.
 */
function awaited(word: string) {
  const reached = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    begun: (words: readonly string[]) => {
      if (words.includes(word)) reached.resolve();
    },
  };
}

/** Ворота: исполнение стоит на чтении, пока тест не отпустит. */
function gate() {
  const open = Promise.withResolvers<void>();
  const reads: string[] = [];
  const waiting: (() => void)[] = [];
  return {
    reads,
    /** Ждёт, пока чтений станет `count`. */
    entered: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (reads.length >= count) resolve();
        };
        waiting.push(check);
        check();
      }),
    release: () => open.resolve(),
    io: {
      readFile: async (path: string) => {
        reads.push(path);
        for (const check of waiting) check();
        await open.promise;
        // Пустой файл — не книга: строка кончится ошибкой разбора, код
        // не важен, важен сам факт исполнения.
        return new Uint8Array();
      },
    },
  };
}

it("две строки идут разом: быстрая не ждёт долгую", async () => {
  const slow = gate();
  await withBack(
    async (back) => {
      const long = await open(back, READING("/a.xlsx"));
      await slow.entered(1);
      // Пока первая стоит на чтении, вторая доходит до своего кадра
      // `exit` — при очереди «по одной» она не начала бы исполняться.
      const quick = await open(back, ["version"]);
      const frames = await within(
        quick.finished(),
        5000,
        "exit быстрой строки",
      );
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      expect(long.frames.some((frame) => "exit" in frame)).toBe(false);
      slow.release();
      await long.finished();
      expect(slow.reads).toStrictEqual(["/a.xlsx"]);
    },
    { io: slow.io },
  );
});

it("предел: лишняя строка начинает, как только место освободилось", async () => {
  const held = gate();
  const third = awaited("/третья.xlsx");
  await withBack(
    async (back) => {
      const busy = [];
      for (let index = 0; index < 2; index++) {
        busy.push(await open(back, READING(`/${index}.xlsx`)));
      }
      await held.entered(2);
      // Третья строка при пределе два не исполняется: мест нет.
      const extra = await open(back, READING("/третья.xlsx"));
      await within(third.reached, 5000, "журнал третьей строки");
      expect(held.reads).toStrictEqual(["/0.xlsx", "/1.xlsx"]);
      held.release();
      await extra.finished();
      expect(held.reads).toStrictEqual(["/0.xlsx", "/1.xlsx", "/третья.xlsx"]);
      for (const line of busy) await line.finished();
    },
    { io: held.io, lines: 2, begun: third.begun },
  );
});

it("строка, упавшая исключением, не мешает соседним", async () => {
  await withBack(
    async (back) => {
      const broken = await open(back, READING("/взрыв.xlsx"));
      expect((await broken.finished()).at(-1)).toStrictEqual({ exit: 1 });
      // Место в пределе отпущено, сервер жив: соседняя строка проходит.
      const next = await open(back, ["version"]);
      expect((await next.finished()).at(-1)).toStrictEqual({ exit: 0 });
      expect(back.diagnosed).toStrictEqual([]);
    },
    {
      io: {
        readFile: () => Promise.reject(new Error("диск взорвался")),
      },
      lines: 1,
    },
  );
});

it("строка, закрытая до своего места, отпускает его следующей", async () => {
  const held = gate();
  const second = awaited("/b.xlsx");
  await withBack(
    async (back) => {
      const first = await open(back, READING("/a.xlsx"));
      await held.entered(1);
      const closed = await open(back, READING("/b.xlsx"));
      await within(second.reached, 5000, "журнал строки B");
      closed.close();
      await closed.closed();
      held.release();
      await first.finished();
      const next = await open(back, ["version"]);
      const frames = await within(next.finished(), 5000, "exit строки C");
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      // Закрытая строка не исполнялась: её файла никто не читал.
      expect(held.reads).toStrictEqual(["/a.xlsx"]);
    },
    { io: held.io, lines: 1, begun: second.begun },
  );
});

it("строка, ждущая ответа, места не занимает", async () => {
  await withBack(
    async (back) => {
      askOn(back, "xlsx alias ls");
      const a = await open(back, ["ask", "xlsx", "alias", "ls"]);
      await a.frame((frame) => "ask" in frame);
      const b = await open(back, ["version"]);
      const bFrames = await within(b.finished(), 5000, "exit строки B");
      expect(bFrames.at(-1)).toStrictEqual({ exit: 0 });
      expect(a.frames.some((frame) => "exit" in frame)).toBe(false);
      a.answer("y");
      const aFrames = await a.finished();
      expect(aFrames.at(-1)).toStrictEqual({ exit: 0 });
      expect(back.called).toStrictEqual(["xlsx alias ls"]);
    },
    { lines: 1 },
  );
});

it("ответа нет 120 секунд — не подтверждено, команда не вызвана", async () => {
  fakeTimers();
  await withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["ask", "xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - 1);
    expect(a.frames.some((frame) => "exit" in frame)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await a.finished()).toStrictEqual([
      { ask: "выполнить mpu xlsx alias ls? [y/N] " },
      refusalFrame(NOT_CONFIRMED, `mpu xlsx alias ls: ${NOT_CONFIRMED}`),
      { err: "mpu xlsx alias ls: не подтверждено\n" },
      { exit: 1 },
    ]);
    expect(back.called).toStrictEqual([]);
  });
});

it("клиент закрыл сокет, не ответив — исполнения нет", async () => {
  const called: string[][] = [];
  await withBack(async (back) => {
    called.push(back.called);
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["ask", "xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    a.close();
    await a.closed();
  });
  // Остановка ждёт строку до конца: к этому месту она доведена.
  expect(called).toStrictEqual([[]]);
});

it("кадр не-ответ после первого игнорируется", async () => {
  await withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const a = await open(back, ["ask", "xlsx", "alias", "ls"]);
    await a.frame((frame) => "ask" in frame);
    a.send({ words: ["version"] });
    a.send("мусор");
    a.answer("yes");
    const frames = await a.finished();
    expect(frames.at(-1)).toStrictEqual({ exit: 0 });
    expect(back.called).toStrictEqual(["xlsx alias ls"]);
  });
});

it("предел: место занято до leave, повторный leave не лишний", async () => {
  const lines = new Lines(2);
  const events: string[] = [];
  const first = await lines.enter();
  const second = await lines.enter();
  const third = lines.enter().then((slot) => {
    events.push("третье место");
    return slot;
  });
  await Promise.resolve();
  expect(events).toStrictEqual([]);
  events.push("отпустили первое");
  first.leave();
  // Повторный `leave` того же места не освобождает чужое.
  first.leave();
  const held = await third;
  expect(events).toStrictEqual(["отпустили первое", "третье место"]);
  const fourth = lines.enter().then(() => void events.push("четвёртое место"));
  await Promise.resolve();
  expect(events).toStrictEqual(["отпустили первое", "третье место"]);
  second.leave();
  await fourth;
  held.leave();
});
