/**
 * Канал Claude Code в ядре (`claude-channel.md`, «Регистрация в ядре»;
 * `claude-hook-stop.md`, «Исходы»; сценарии постановки R2b — номерами в
 * именах тестов): регистрация по ключу сессии, доставка текста владельца,
 * обрыв — «сессия закрыта», вытеснение вторым каналом. Канал — сырой
 * WebSocket теста, бот — фейк.
 */

import { assertEquals } from "@std/assert";
import {
  deliveredFrame,
  failedFrame,
  helloFrame,
  STOP,
} from "../frames/mod.ts";
import { FakeBot, fakeQuestions, textUpdate } from "../botquestions/testbot.ts";
import { Client, type TestBack, withBack, within } from "./testback.ts";

const KEY = "/run/user/1000/cc-socks/42.sock";

/** Канал теста: кадры ядра по порядку и ответ на них. */
class Channel {
  readonly frames: string[] = [];
  readonly #socket: WebSocket;
  readonly #ready = Promise.withResolvers<void>();
  readonly #closed = Promise.withResolvers<void>();
  #waiters: { count: number; done: () => void }[] = [];

  constructor(back: TestBack, key: string) {
    this.#socket = new WebSocket(`${back.url.replace("http", "ws")}/channel`, {
      protocols: ["mpu", `bearer.${back.token}`],
    });
    this.#socket.onopen = () => this.#socket.send(helloFrame(key));
    this.#socket.onmessage = (event) => {
      const frame = String(event.data);
      if (frame === '{"ready":true}') {
        this.#ready.resolve();
        return;
      }
      this.frames.push(frame);
      for (const waiter of this.#waiters) {
        if (this.frames.length >= waiter.count) waiter.done();
      }
    };
    this.#socket.onerror = () => {};
    this.#socket.onclose = () => this.#closed.resolve();
  }

  /** Регистрация принята ядром. */
  ready(): Promise<void> {
    return within(this.#ready.promise, 5000, "регистрация канала");
  }

  /** Ждёт `count` кадров доставки. */
  heard(count: number): Promise<void> {
    if (this.frames.length >= count) return Promise.resolve();
    const reached = Promise.withResolvers<void>();
    this.#waiters.push({ count, done: reached.resolve });
    return within(reached.promise, 5000, `кадр доставки ${count}`);
  }

  send(frame: string): void {
    this.#socket.send(frame);
  }

  async close(): Promise<void> {
    this.#socket.close();
    await this.#closed.promise;
  }
}

/** Живой payload `Stop` сессии `KEY`; транскрипта нет. */
async function stopLine(back: TestBack, message: string): Promise<Client> {
  const live = JSON.parse(
    await Deno.readTextFile(
      new URL("../claudehook/testdata/stop/live-stop.json", import.meta.url),
    ),
  );
  const client = new Client(back, "/line");
  await client.opened();
  client.send({
    words: STOP.words,
    cwd: Deno.cwd(),
    human: false,
    stdin: JSON.stringify({
      ...live,
      transcript_path: "/нет/транскрипта",
      last_assistant_message: message,
    }),
    env: { CLAUDE_CODE_MESSAGING_SOCKET: KEY },
  });
  return client;
}

const HEAD = "💬 ozon\nКакой цвет?";

/** Стенд: ядро с фейком бота и опросом. */
async function withChannelBack(
  body: (back: TestBack, bot: FakeBot) => Promise<void>,
): Promise<void> {
  const bot = new FakeBot();
  await withBack((back) => body(back, bot), { questions: fakeQuestions(bot) });
}

Deno.test("R2b-3: сессия с каналом — «Позже» · «Пропустить» без строки «в терминале»; текст — уведомление в канал, «✅ Синий — из чата»", () =>
  withChannelBack(async (back, bot) => {
    const channel = new Channel(back, KEY);
    await channel.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    assertEquals(bot.calls[0].text, HEAD);
    assertEquals(bot.calls[0].buttons, [["Позже", "Пропустить"]]);
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await channel.heard(1);
    assertEquals(channel.frames[0], '{"deliver":"Синий","id":1}');
    channel.send(deliveredFrame(1));
    await within(bot.called(2), 5000, "исход");
    assertEquals(bot.calls[1].text, `${HEAD}\n✅ Синий — из чата`);
    assertEquals(bot.calls[1].buttons, []);
    await channel.close();
  }));

Deno.test("R2b-4: канал закрылся при активном «ждёт ввода» — «⌛ сессия закрыта», кнопок нет", () =>
  withChannelBack(async (back, bot) => {
    const channel = new Channel(back, KEY);
    await channel.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    await channel.close();
    await within(bot.called(2), 5000, "исход");
    assertEquals(bot.calls[1].text, `${HEAD}\n⌛ сессия закрыта`);
    assertEquals(bot.calls[1].buttons, []);
  }));

Deno.test("R2b-6: второй канал того же ключа — текст во второй, закрытие первого вопрос не снимает", () =>
  withChannelBack(async (back, bot) => {
    const first = new Channel(back, KEY);
    await first.ready();
    const second = new Channel(back, KEY);
    await second.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    await first.close();
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await second.heard(1);
    assertEquals(first.frames, []);
    second.send(deliveredFrame(1));
    await within(bot.called(2), 5000, "исход");
    assertEquals(bot.calls[1].text, `${HEAD}\n✅ Синий — из чата`);
    await second.close();
  }));

Deno.test("R2b-7: канал не записал — «не доставлено: сессия без канала», вопрос активен", () =>
  withChannelBack(async (back, bot) => {
    const channel = new Channel(back, KEY);
    await channel.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await channel.heard(1);
    channel.send(failedFrame(1));
    await within(bot.called(2), 5000, "отказ владельцу");
    assertEquals(bot.calls[1], {
      method: "send",
      message: 0,
      text: "не доставлено: сессия без канала",
      buttons: [],
      data: [],
    });
    // Активен: следующий текст снова уходит в канал.
    bot.deliver([textUpdate(2, 111, "Синий", 1)]);
    await channel.heard(2);
    channel.send(deliveredFrame(2));
    await within(bot.called(3), 5000, "исход");
    assertEquals(bot.calls[2].text, `${HEAD}\n✅ Синий — из чата`);
    await channel.close();
  }));

Deno.test("первый кадр не ключ — соединение закрыто ядром", () =>
  withChannelBack(async (back) => {
    const socket = new WebSocket(`${back.url.replace("http", "ws")}/channel`, {
      protocols: ["mpu", `bearer.${back.token}`],
    });
    const closed = Promise.withResolvers<void>();
    socket.onopen = () => socket.send("{}");
    socket.onclose = () => closed.resolve();
    socket.onerror = () => {};
    await within(closed.promise, 5000, "закрытие");
  }));

Deno.test("без токена — 401, канал не регистрируется", () =>
  withChannelBack(async (back) => {
    const response = await fetch(`${back.url}/channel`);
    await response.body?.cancel();
    assertEquals(response.status, 401);
  }));
