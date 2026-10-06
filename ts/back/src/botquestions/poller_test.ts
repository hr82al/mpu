/**
 * Долгий опрос (`docs/specs/platform/telegram-questions.md`, «Приём
 * апдейтов»): повтор через 5 с, строка 409 — одна на серию, остановка
 * прерывает и опрос, и паузу.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { BotFailure } from "./bot_api.ts";
import { type Clock, Poller, REAL_CLOCK, RETRY_MS } from "./poller.ts";
import { FakeBot, textUpdate } from "./testbot.ts";
import type { Inbox } from "./updates.ts";

const CONFLICT = new BotFailure(
  "409 Conflict: terminated by other getUpdates request",
  409,
);
const DOWN = new BotFailure("connection refused", 0);

/** Часы, записывающие паузы; пауза кончается сразу. */
function clock(): Clock & { readonly pauses: number[] } {
  const pauses: number[] = [];
  return {
    pauses,
    now: () => 1_791_270_000_000,
    pause: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
  };
}

const SILENT_INBOX: Inbox = {
  press: () => Promise.resolve(),
  write: () => Promise.resolve(),
};

Deno.test("сбои подряд — строка на серию 409 и строка на серию прочих, пауза 5 с на каждый", async () => {
  const bot = new FakeBot();
  bot.pollFailures.push(CONFLICT, CONFLICT, DOWN, CONFLICT);
  const time = clock();
  const log: string[] = [];
  const poller = new Poller({
    bot,
    inbox: SILENT_INBOX,
    clock: time,
    diagnose: (line) => log.push(line),
  });
  const stop = new AbortController();
  const running = poller.run(stop.signal);
  // Пятый опрос — первый удачный: серия кончилась.
  await bot.polled(5);
  bot.pollFailures.push(CONFLICT);
  bot.deliver([]);
  await bot.polled(7);
  stop.abort();
  await running;
  assertEquals(time.pauses, [
    RETRY_MS,
    RETRY_MS,
    RETRY_MS,
    RETRY_MS,
    RETRY_MS,
  ]);
  assertEquals(log, [
    "telegram: у бота другой читатель (409)",
    "telegram: опрос не удался: connection refused",
    "telegram: у бота другой читатель (409)",
  ]);
});

Deno.test("500 три раза подряд — одна строка «опрос не удался»", async () => {
  const bot = new FakeBot();
  const failure = new BotFailure("500 Internal Server Error", 500);
  bot.pollFailures.push(failure, failure, failure);
  const log: string[] = [];
  const poller = new Poller({
    bot,
    inbox: SILENT_INBOX,
    clock: clock(),
    diagnose: (line) => log.push(line),
  });
  const stop = new AbortController();
  const running = poller.run(stop.signal);
  await bot.polled(4);
  stop.abort();
  await running;
  assertEquals(log, ["telegram: опрос не удался: 500 Internal Server Error"]);
});

Deno.test("текст до старта отброшен и во второй пачке", async () => {
  const bot = new FakeBot();
  const seen: string[] = [];
  const poller = new Poller({
    bot,
    inbox: {
      press: () => Promise.resolve(),
      write: (_sender, text) => {
        seen.push(text);
        return Promise.resolve();
      },
    },
    clock: clock(),
    diagnose: () => {},
  });
  const stop = new AbortController();
  const running = poller.run(stop.signal);
  bot.deliver([textUpdate(40, 111, "после", 1_791_270_000)]);
  await bot.polled(2);
  bot.deliver([textUpdate(41, 111, "до старта", 1_791_269_999)]);
  await bot.polled(3);
  stop.abort();
  await running;
  assertEquals(seen, ["после"]);
});

Deno.test("остановка во время паузы — опрос кончается без ошибки", async () => {
  const bot = new FakeBot();
  bot.pollFailures.push(DOWN);
  const stop = new AbortController();
  const paused = Promise.withResolvers<void>();
  const poller = new Poller({
    bot,
    inbox: SILENT_INBOX,
    clock: {
      now: () => 0,
      pause: (_ms, signal) => {
        paused.resolve();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        );
      },
    },
    diagnose: () => {},
  });
  const running = poller.run(stop.signal);
  await paused.promise;
  stop.abort();
  await running;
  assertEquals(bot.polls, 1);
});

Deno.test("непредвиденная ошибка опроса не глотается", async () => {
  const poller = new Poller({
    bot: {
      ...new FakeBot(),
      updates: () => Promise.reject(new TypeError("сломано")),
      send: () => Promise.resolve(0),
      edit: () => Promise.resolve(),
      ack: () => Promise.resolve(),
    },
    inbox: SILENT_INBOX,
    clock: clock(),
    diagnose: () => {},
  });
  await assertRejects(
    () => poller.run(new AbortController().signal),
    TypeError,
    "сломано",
  );
});

Deno.test("отброшенный апдейт тоже сдвигает offset", async () => {
  const bot = new FakeBot();
  const seen: string[] = [];
  const poller = new Poller({
    bot,
    inbox: {
      press: () => Promise.resolve(),
      write: (_sender, text) => {
        seen.push(text);
        return Promise.resolve();
      },
    },
    clock: clock(),
    diagnose: () => {},
  });
  const stop = new AbortController();
  const running = poller.run(stop.signal);
  bot.deliver([
    textUpdate(40, 111, "до старта", 1_791_269_999),
    textUpdate(41, 111, "после", 1_791_270_000),
  ]);
  await bot.polled(2);
  stop.abort();
  await running;
  assertEquals(seen, ["после"]);
  assertEquals(bot.offsets, [0, 42]);
});

Deno.test("пауза настоящих часов на уже прерванном сигнале отвергается сразу", async () => {
  const stop = new AbortController();
  stop.abort();
  let rejected = false;
  const paused = REAL_CLOCK.pause(1, stop.signal).then(
    () => {},
    () => void (rejected = true),
  );
  // Отказ — в том же обороте: таймер паузы до него не доходит.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(rejected, true);
  await paused;
});
