/**
 * Программа на сервере строк (`platform/evaluator.md`, «Где
 * исполняется»): исполнитель программы вне предела пула, её команды —
 * отдельными строками ядра, отмена — кадром `stop`. Исполнители — в
 * памяти теста, тот же протокол кадров, что у процесса.
 */

import { assert, assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import { CANCELLED_CODE } from "./stopping.ts";
import { Client, line, withBack, within } from "./testback.ts";

const { open: DO, blockEnd: DONE, separator: SEP, assign: ASSIGN } = GRAMMAR;

/** Коды записей журнала по мере их закрытия. */
function journal() {
  const codes: number[] = [];
  const waiting: (() => void)[] = [];
  return {
    codes,
    /** Ждёт, пока записей станет `count`. */
    written: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (codes.length >= count) resolve();
        };
        waiting.push(check);
        check();
      }),
    finishedWith: (code: number) => {
      codes.push(code);
      for (const check of waiting) check();
    },
  };
}

Deno.test("программа на исполнителе: печать и итог через сервер", () =>
  withBack(async (back) => {
    const frames = await line(back, "/line", [
      "x",
      ASSIGN,
      "5",
      SEP,
      "x",
      "plus:",
      "2",
    ]);
    assertEquals(frames.filter((frame) => "out" in frame), [{ out: "7\n" }]);
    assertEquals(frames.at(-1), { exit: 0 });
  }));

Deno.test("предел строк 1: программа и её команда — без взаимного ожидания", () =>
  withBack(async (back) => {
    const frames = await within(
      line(back, "/line", ["x", ASSIGN, "jsdate", SEP, "x", "isNil"]),
      10_000,
      "программа с командой при --lines 1",
    );
    assertEquals(frames.filter((frame) => "out" in frame), [
      { out: "false\n" },
    ]);
    assertEquals(frames.at(-1), { exit: 0 });
  }, { lines: 1 }));

Deno.test("отмена бесконечного цикла доходит кадром stop за секунду, код 130", async () => {
  const log = journal();
  await withBack(async (back) => {
    const client = new Client(back, "/line");
    await client.opened();
    client.start([
      "1",
      "to:",
      "1000000000",
      "do:",
      DO,
      ":i",
      "i",
      "print",
      DONE,
    ]);
    // Цикл идёт: печать дошла, строка не кончилась.
    await within(
      client.frame((frame) => "out" in frame),
      5_000,
      "первая печать цикла",
    );
    const started = performance.now();
    client.close();
    await within(log.written(1), 5_000, "запись журнала отменённой строки");
    const took = performance.now() - started;
    assert(took < 1_000, `остановка заняла ${Math.round(took)} мс`);
  }, { finishedWith: log.finishedWith });
  assertEquals(log.codes, [CANCELLED_CODE]);
});
