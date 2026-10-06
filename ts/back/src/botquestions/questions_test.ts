/**
 * Служба вопросов целиком: опрос → владелец → ряд, перезапуск ядра и
 * сборка по ключам env-файла (`docs/specs/platform/telegram-questions.md`;
 * сценарии постановки R1a — номерами в именах тестов).
 */

import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { fakeConfigDb } from "../testing/mod.ts";
import { BotFailure } from "./bot_api.ts";
import { Card } from "./card.ts";
import type { Clock } from "./poller.ts";
import { BotQuestions, NO_BOT, ownerQuestions } from "./questions.ts";
import { NO_MEMORY, type ShownMessages, StoredMessages } from "./shown.ts";
import {
  f1,
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "./testbot.ts";
import type { OutcomeReader } from "./outcome.ts";

/** Старт ядра в тестах: 2026-10-06, мс. */
const STARTED_MS = 1_791_270_000_000;
const STARTED = STARTED_MS / 1000;

/** Часы стоят; пауза не нужна — опрос в этих тестах не отказывает. */
const CLOCK: Clock = {
  now: () => STARTED_MS,
  pause: () => Promise.resolve(),
};

const KIND: OutcomeReader<string> = {
  answered: () => "ответ",
  withdrawn: () => "снят",
  expired: () => "истёк",
  refused: (reason) => `отказ: ${reason}`,
};

function service(bot: FakeBot, shown: ShownMessages = NO_MEMORY) {
  const log: string[] = [];
  const questions = new BotQuestions({
    bot,
    owner: 111,
    shown,
    clock: CLOCK,
    run: "r1",
    diagnose: (line) => log.push(line),
  });
  return { questions, log };
}

Deno.test("2 через опрос: нажатие владельца решает вопрос", async () => {
  const bot = new FakeBot();
  const { questions } = service(bot);
  questions.start();
  const asked = questions.ask(f1());
  await bot.called(1);
  bot.deliver([pressUpdate(7, 111, "r1:1:0:0")]);
  await bot.polled(2);
  await questions.stop();
  assertEquals((await asked.outcome).read(KIND), "ответ");
  assertEquals(bot.calls.map((call) => call.method), ["send", "ack", "edit"]);
  assertEquals(bot.offsets, [0, 8]);
});

Deno.test("4: нажатие чужого — «не ваш вопрос», текст чужого — молчание", async () => {
  const bot = new FakeBot();
  const { questions } = service(bot);
  questions.start();
  const asked = questions.ask(f1());
  await bot.called(1);
  bot.deliver([
    pressUpdate(1, 222, "r1:1:0:0"),
    textUpdate(2, 222, "да", STARTED + 5),
  ]);
  await bot.polled(2);
  asked.expire();
  await questions.stop();
  assertEquals(bot.calls.map((call) => [call.method, call.text]), [
    ["send", "🔐 Bash — ozon\nCreate probe file\ntouch /tmp/x1.txt"],
    ["ack", "не ваш вопрос"],
    [
      "edit",
      "🔐 Bash — ozon\nCreate probe file\ntouch /tmp/x1.txt\n⌛ истёк — ответьте в терминале",
    ],
  ]);
  assertEquals((await asked.outcome).read(KIND), "истёк");
});

Deno.test("владелец в группе с ботом: текст — молчание, нажатие — «не ваш вопрос»", async () => {
  const bot = new FakeBot();
  const { questions } = service(bot);
  questions.start();
  const asked = questions.ask(f1());
  await bot.called(1);
  bot.deliver([
    textUpdate(1, 111, "нет", STARTED + 5, -100500),
    pressUpdate(2, 111, "r1:1:0:0", -100500),
  ]);
  await bot.polled(2);
  asked.expire();
  await questions.stop();
  assertEquals(bot.calls.map((call) => [call.method, call.text]), [
    ["send", "🔐 Bash — ozon\nCreate probe file\ntouch /tmp/x1.txt"],
    ["ack", "не ваш вопрос"],
    [
      "edit",
      "🔐 Bash — ozon\nCreate probe file\ntouch /tmp/x1.txt\n⌛ истёк — ответьте в терминале",
    ],
  ]);
  assertEquals((await asked.outcome).read(KIND), "истёк");
});

Deno.test("12: текст, датированный до старта, — отброшен в любой пачке", async () => {
  const bot = new FakeBot();
  const { questions } = service(bot);
  questions.start();
  bot.deliver([textUpdate(1, 111, "старое", STARTED - 1)]);
  await bot.polled(2);
  assertEquals(bot.calls, []);
  bot.deliver([textUpdate(2, 111, "тоже старое", STARTED - 1)]);
  await bot.polled(3);
  await questions.stop();
  assertEquals(bot.calls, []);
  assertEquals(bot.offsets, [0, 2, 3]);
});

Deno.test("12: текст первого опроса, датированный стартом, — принят", async () => {
  const bot = new FakeBot();
  const { questions } = service(bot);
  questions.start();
  bot.deliver([textUpdate(1, 111, "привет", STARTED)]);
  await bot.polled(2);
  await questions.stop();
  assertEquals(bot.calls.map((call) => call.text), ["сейчас вопросов нет"]);
});

Deno.test("13: сообщение прошлого запуска — при старте «истёк» без кнопок, запись забыта", async () => {
  const open = fakeConfigDb();
  const log: string[] = [];
  const shown = new StoredMessages(open, (line) => log.push(line));
  shown.remember(
    1546,
    new Card("🔐 Bash — ozon", "touch /tmp/x1.txt", []),
  );
  const bot = new FakeBot();
  const { questions } = service(bot, shown);
  questions.start();
  // Вопрос, заданный сразу после старта, показывается после правки
  // прошлого: кнопки в чате не бывают у двух сообщений разом.
  const asked = questions.ask(f1());
  asked.expire();
  await questions.stop();
  assertEquals(bot.calls[0], {
    method: "edit",
    message: 1546,
    text: "🔐 Bash — ozon\ntouch /tmp/x1.txt\n⌛ истёк — ответьте в терминале",
    buttons: [],
    data: [],
  });
  assertEquals(shown.all(), []);
  assertEquals(log, []);
});

/** env-файл из словаря. */
function env(values: Readonly<Record<string, string>>) {
  return {
    get: (name: string) => values[name],
    require: (name: string) => {
      const value = values[name];
      if (value === undefined) throw new DomainError(`нет ключа ${name}`);
      return value;
    },
  };
}

const DEPS = {
  openCacheDb: fakeConfigDb(),
  diagnose: () => {},
};

Deno.test("11: нет ключей бота — «бот не настроен», опроса нет", async () => {
  const cases: readonly Readonly<Record<string, string>>[] = [
    {},
    { TELEGRAM_BOT_TOKEN: "8123:AAH" },
    { TELEGRAM_BOT_ID: "111" },
    { TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_ID: "111" },
  ];
  for (const values of cases) {
    const questions = ownerQuestions(env(values), DEPS);
    assertEquals(questions, NO_BOT);
    questions.start();
    const outcome = await questions.ask(f1()).outcome;
    assertEquals(outcome.read(KIND), "отказ: бот не настроен");
    await questions.stop();
  }
});

Deno.test("ключ id негоден — «бот не настроен», причина в журнал службы", () => {
  const log: string[] = [];
  const questions = ownerQuestions(
    env({ TELEGRAM_BOT_TOKEN: "8123:AAH", TELEGRAM_BOT_ID: "@owner" }),
    { openCacheDb: fakeConfigDb(), diagnose: (line) => log.push(line) },
  );
  assertEquals(questions, NO_BOT);
  assertEquals(log, [
    "telegram: TELEGRAM_BOT_ID должен быть числом, получено '@owner'; вопросы в Telegram отключены",
  ]);
});

Deno.test("оба ключа есть — служба с ботом", () => {
  const questions = ownerQuestions(
    env({ TELEGRAM_BOT_TOKEN: "8123:AAH", TELEGRAM_BOT_ID: "111" }),
    DEPS,
  );
  assertNotStrictEquals(questions, NO_BOT);
});

Deno.test("правка в «истёк» при старте не удалась — запись остаётся до следующего старта", async () => {
  const shown = new StoredMessages(fakeConfigDb(), () => {});
  shown.remember(1546, new Card("🔐 Bash", "ls", []));
  const bot = new FakeBot();
  bot.fail("edit", new BotFailure("connection refused", 0));
  const { questions, log } = service(bot, shown);
  questions.start();
  await questions.stop();
  assertEquals(shown.all().map(({ id }) => id), [1546]);
  assertEquals(log, [
    "telegram: правка сообщения: бот недоступен: connection refused",
  ]);
});

Deno.test("непредвиденный сбой опроса — строка журнала, процесс не падает", async () => {
  const bot = new FakeBot();
  bot.updates = () => Promise.reject(new TypeError("сломано"));
  const logged = Promise.withResolvers<string>();
  const questions = new BotQuestions({
    bot,
    owner: 111,
    shown: NO_MEMORY,
    clock: CLOCK,
    run: "r1",
    diagnose: logged.resolve,
  });
  questions.start();
  assertEquals(
    await logged.promise,
    "telegram: опрос остановлен: TypeError: сломано",
  );
  await questions.stop();
});

Deno.test("непригодный прокси — пароль в журнал не попадает", () => {
  const log: string[] = [];
  const questions = ownerQuestions(
    env({
      TELEGRAM_BOT_TOKEN: "8123:AAH",
      TELEGRAM_BOT_ID: "111",
      TELEGRAM_PROXY: "http://user:pa55@proxy.local",
    }),
    { openCacheDb: fakeConfigDb(), diagnose: (line) => log.push(line) },
  );
  assertEquals(questions, NO_BOT);
  assertEquals(log.length, 1);
  assertEquals(log[0].includes("pa55"), false, log[0]);
});

Deno.test("сообщение поправить нельзя (400) — запись забыта, а не повторяется вечно", async () => {
  const shown = new StoredMessages(fakeConfigDb(), () => {});
  shown.remember(1546, new Card("🔐 Bash", "ls", []));
  const bot = new FakeBot();
  bot.fail(
    "edit",
    new BotFailure("400 Bad Request: message to edit not found", 400),
  );
  const { questions } = service(bot, shown);
  questions.start();
  await questions.stop();
  assertEquals(shown.all(), []);
});

Deno.test("R4: отдельное сообщение — номер; без бота — «бот не настроен»", async () => {
  const bot = new FakeBot();
  const questions = fakeQuestions(bot);
  const reader = {
    sent: (id: number) => `ушло ${id}`,
    refused: (why: string) => `отказ: ${why}`,
  };
  assertEquals(
    (await questions.post({ text: "экран", entities: [] })).read(reader),
    "ушло 1546",
  );
  assertEquals(bot.calls[0].buttons, []);
  assertEquals(
    (await NO_BOT.post({ text: "экран", entities: [] })).read(reader),
    "отказ: бот не настроен",
  );
});
