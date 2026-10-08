/**
 * Канал Claude Code в ядре (`claude-channel.md`, «Регистрация в ядре»;
 * `claude-hook-stop.md`, «Исходы»; сценарии постановки R2b — номерами в
 * именах тестов): регистрация по ключу сессии, доставка текста владельца,
 * обрыв — «сессия закрыта», вытеснение вторым каналом. Канал — сырой
 * WebSocket теста, бот — фейк.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  deliveredFrame,
  failedFrame,
  helloFrame,
  STOP,
} from "@mpu/language/frames";
import {
  FakeBot,
  fakeQuestions,
  textUpdate,
} from "@mpu/cmd-botquestions/testing";
import {
  Client,
  openSocket,
  type TestBack,
  withBack,
  within,
} from "./testback.ts";

const KEY = "/run/user/1000/cc-socks/42.sock";

/** Канал теста: кадры ядра по порядку и ответ на них. */
class Channel {
  readonly frames: string[] = [];
  readonly #socket: WebSocket;
  readonly #ready = Promise.withResolvers<void>();
  readonly #closed = Promise.withResolvers<void>();
  #waiters: { count: number; done: () => void }[] = [];

  constructor(back: TestBack, key: string) {
    this.#socket = openSocket(`${back.url.replace("http", "ws")}/channel`, {
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
    await readFile(
      new URL("../claudehook/testdata/stop/live-stop.json", import.meta.url),
      "utf8",
    ),
  );
  const client = new Client(back, "/line");
  await client.opened();
  client.send({
    words: STOP.words,
    cwd: process.cwd(),
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

it("R2b-3: сессия с каналом — «Позже» · «Пропустить» без строки «в терминале»; текст — уведомление в канал, «✅ Синий — из чата»", () =>
  withChannelBack(async (back, bot) => {
    const channel = new Channel(back, KEY);
    await channel.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    expect(bot.calls[0].text).toStrictEqual(HEAD);
    expect(bot.calls[0].buttons).toStrictEqual([["Позже", "Пропустить"]]);
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await channel.heard(1);
    expect(channel.frames[0]).toBe('{"deliver":"Синий","id":1}');
    channel.send(deliveredFrame(1));
    await within(bot.called(2), 5000, "исход");
    expect(bot.calls[1].text).toStrictEqual(`${HEAD}\n✅ Синий — из чата`);
    expect(bot.calls[1].buttons).toStrictEqual([]);
    await channel.close();
  }));

it("R2b-4: канал закрылся при активном «ждёт ввода» — «⌛ сессия закрыта», кнопок нет", () =>
  withChannelBack(async (back, bot) => {
    const channel = new Channel(back, KEY);
    await channel.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    await channel.close();
    await within(bot.called(2), 5000, "исход");
    expect(bot.calls[1].text).toStrictEqual(`${HEAD}\n⌛ сессия закрыта`);
    expect(bot.calls[1].buttons).toStrictEqual([]);
  }));

it("R2b-6: второй канал того же ключа — текст во второй, закрытие первого вопрос не снимает", () =>
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
    expect(first.frames).toStrictEqual([]);
    second.send(deliveredFrame(1));
    await within(bot.called(2), 5000, "исход");
    expect(bot.calls[1].text).toStrictEqual(`${HEAD}\n✅ Синий — из чата`);
    await second.close();
  }));

it("R2b-7: канал не записал — «не доставлено: сессия без канала», вопрос активен", () =>
  withChannelBack(async (back, bot) => {
    const channel = new Channel(back, KEY);
    await channel.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await channel.heard(1);
    channel.send(failedFrame(1));
    await within(bot.called(2), 5000, "отказ владельцу");
    expect(bot.calls[1]).toStrictEqual({
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
    expect(bot.calls[2].text).toStrictEqual(`${HEAD}\n✅ Синий — из чата`);
    await channel.close();
  }));

it("первый кадр не ключ — соединение закрыто ядром", () =>
  withChannelBack(async (back) => {
    const socket = openSocket(`${back.url.replace("http", "ws")}/channel`, {
      protocols: ["mpu", `bearer.${back.token}`],
    });
    const closed = Promise.withResolvers<void>();
    socket.onopen = () => socket.send("{}");
    socket.onclose = () => closed.resolve();
    socket.onerror = () => {};
    await within(closed.promise, 5000, "закрытие");
  }));

it("без токена — 401, канал не регистрируется", () =>
  withChannelBack(async (back) => {
    const response = await fetch(`${back.url}/channel`);
    await response.body?.cancel();
    expect(response.status).toBe(401);
  }));

it("текст — только в канал сессии активного «ждёт ввода»: канал другой сессии его не получает", () =>
  withChannelBack(async (back, bot) => {
    const mine = new Channel(back, KEY);
    const other = new Channel(back, "/run/user/1000/cc-socks/43.sock");
    await mine.ready();
    await other.ready();
    await (await stopLine(back, "Какой цвет?")).closed();
    await within(bot.called(1), 5000, "сообщение «ждёт ввода»");
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await mine.heard(1);
    mine.send(deliveredFrame(1));
    await within(bot.called(2), 5000, "исход");
    expect(other.frames).toStrictEqual([]);
    await mine.close();
    await other.close();
  }));
