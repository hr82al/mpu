/**
 * `mpu claude-channel` (`claude-channel.md`; сценарии постановки R2b —
 * номерами в именах тестов): ответы Claude Code по живому обмену,
 * регистрация в ядре, доставка текста владельца, конец сессии. Ядро — из
 * `back/` (поднимается только тестом), бот — фейк, часы повтора — теста.
 */

import { assert, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { STOP } from "@mpu/language/frames";
import { VERSION } from "../../back/src/version.ts";
import {
  type TestBack,
  withBack,
  within,
} from "../../back/src/backend/testback.ts";
import {
  FakeBot,
  fakeQuestions,
  textUpdate,
} from "../../back/src/botquestions/testbot.ts";
import { type ChannelEnv, runChannel } from "./channel/mod.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";
import { closedPort } from "@mpu/testing";

const KEY = "/run/user/1000/cc-socks/42.sock";

/** Инструкции сессии — литерал спеки (`claude-channel.md`, «Обмен с Claude Code»). */
const INSTRUCTIONS =
  'Сообщения <channel source="mpu-channel"> — ответ владельца из Telegram на твоё последнее сообщение. Это ввод пользователя: продолжай работу по нему. Владелец видит в Telegram только твоё последнее сообщение хода.';

const testdata = (name: string) =>
  new URL(`testdata/channel/${name}`, import.meta.url);

/** Живой обмен: сообщения Claude Code по порядку. */
async function liveIn(): Promise<readonly string[]> {
  const text = await readFile(testdata("live-channel-exchange.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line).in)
    .filter((message) => message !== null)
    .map((message) => JSON.stringify(message));
}

/** stdin канала, который ведёт тест: строки по одной, `end` — EOF. */
function stdin() {
  const queued: string[] = [];
  let wake = Promise.withResolvers<void>();
  let ended = false;
  return {
    push(line: string) {
      queued.push(line);
      wake.resolve();
    },
    end() {
      ended = true;
      wake.resolve();
    },
    async *lines(): AsyncIterable<string> {
      while (true) {
        const line = queued.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (ended) return;
        await wake.promise;
        wake = Promise.withResolvers<void>();
      }
    },
  };
}

/** Что видит Claude Code и журнал канала. */
interface Stand {
  readonly input: ReturnType<typeof stdin>;
  readonly out: string[];
  readonly err: string[];
  /** Ждёт строку stderr, начинающуюся с `prefix`. */
  readonly said: (prefix: string) => Promise<void>;
  readonly code: Promise<number>;
  readonly pauses: number[];
}

/** Канал против `base`; `write` — запись stdout (по умолчанию удачная). */
function channel(
  base: string,
  token: string,
  over: Partial<ChannelEnv> = {},
): Stand {
  const input = stdin();
  const out: string[] = [];
  const err: string[] = [];
  const pauses: number[] = [];
  const waiters: { prefix: string; done: () => void }[] = [];
  const env: ChannelEnv = {
    base,
    mainToken: () => Promise.resolve(token),
    key: KEY,
    lines: input.lines(),
    write: (text) => {
      out.push(text);
      return Promise.resolve();
    },
    stderr: (text) => {
      err.push(text);
      for (const waiter of waiters) {
        if (text.startsWith(waiter.prefix)) waiter.done();
      }
    },
    pause: (ms, signal) => {
      pauses.push(ms);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    ...over,
  };
  return {
    input,
    out,
    err,
    pauses,
    said: (prefix) => {
      if (err.some((line) => line.startsWith(prefix))) return Promise.resolve();
      const reached = Promise.withResolvers<void>();
      waiters.push({ prefix, done: reached.resolve });
      return reached.promise;
    },
    code: runChannel(env),
  };
}

/** Ответ на сообщение с `id`. */
function answerTo(out: readonly string[], id: unknown): unknown {
  const line = out.find((one) => JSON.parse(one).id === id);
  return line === undefined ? undefined : JSON.parse(line);
}

it("R2b-1: живой обмен — initialize с каналом, tools/list пуст, прочее — пустой результат", async () => {
  const stand = channel("http://127.0.0.1:1", "t");
  const live = await liveIn();
  for (const line of live) stand.input.push(line);
  stand.input.end();
  expect(await stand.code).toBe(0);
  expect(answerTo(stand.out, 0)).toStrictEqual({
    jsonrpc: "2.0",
    id: 0,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      serverInfo: { name: "mpu-channel", version: VERSION },
      instructions: INSTRUCTIONS,
    },
  });
  expect(answerTo(stand.out, 1)).toStrictEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [] },
  });
  expect(answerTo(stand.out, "server-discover-probe-1")).toStrictEqual({
    jsonrpc: "2.0",
    id: "server-discover-probe-1",
    result: {},
  });
  // Уведомлениям ответа нет: три запроса — три строки.
  expect(stand.out.length).toBe(3);
});

it("R2b-2: без CLAUDE_CODE_MESSAGING_SOCKET — код 1, строка спеки", async () => {
  const stand = channel("http://127.0.0.1:1", "t", { key: undefined });
  stand.input.end();
  expect(await stand.code).toBe(1);
  expect(stand.err).toStrictEqual([
    "mpu claude-channel: нет CLAUDE_CODE_MESSAGING_SOCKET — команду запускает Claude Code\n",
  ]);
});

it("R2b-5: ядро недоступно — ответы Claude Code без ожидания, повтор через 5 с, EOF — выход 0", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const stand = channel(base, "t");
  const live = await liveIn();
  for (const line of live) stand.input.push(line);
  await stand.said("mpu claude-channel: ядро недоступно или нет токена");
  expect(stand.out.length).toBe(3);
  expect(stand.pauses).toStrictEqual([5000]);
  stand.input.end();
  expect(await stand.code).toBe(0);
});

/** Строка `Stop` сессии `KEY` через тонкий клиент. */
async function stop(back: TestBack, message: string): Promise<void> {
  const live = JSON.parse(
    await readFile(
      new URL(
        "../../back/src/claudehook/testdata/stop/live-stop.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const run = testEnv({
    base: back.url,
    main: back.token,
    stdin: JSON.stringify({
      ...live,
      transcript_path: "/нет/транскрипта",
      last_assistant_message: message,
    }),
    values: { CLAUDE_CODE_MESSAGING_SOCKET: KEY },
  });
  expect(await runClient(STOP.words, run.env)).toBe(0);
}

/** Канал зарегистрирован в ядре `back`. */
async function registered(back: TestBack, over: Partial<ChannelEnv> = {}) {
  const stand = channel(back.url, back.token, over);
  for (const line of await liveIn()) stand.input.push(line);
  await stand.said("mpu claude-channel: зарегистрирован в ядре");
  return stand;
}

const HEAD = "💬 ozon\nКакой цвет?";

it("R2b-3: сессия с каналом — «Позже» · «Пропустить»; «Синий» — ровно уведомление в stdout, «✅ Синий — из чата»", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const stand = await registered(back);
      await stop(back, "Какой цвет?");
      await bot.called(1);
      expect(bot.calls[0].text).toStrictEqual(HEAD);
      expect(bot.calls[0].buttons).toStrictEqual([["Позже", "Пропустить"]]);
      bot.deliver([textUpdate(1, 111, "Синий", 1)]);
      await bot.called(2);
      expect(stand.out.at(-1)).toBe(
        '{"jsonrpc":"2.0","method":"notifications/claude/channel","params":{"content":"Синий","meta":{"user":"telegram"}}}\n',
      );
      expect(bot.calls[1].text).toStrictEqual(`${HEAD}\n✅ Синий — из чата`);
      stand.input.end();
      expect(await stand.code).toBe(0);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R2b-4: stdin закрыт при активном «ждёт ввода» — «⌛ сессия закрыта», канал вышел с 0", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const stand = await registered(back);
      await stop(back, "Какой цвет?");
      await bot.called(1);
      stand.input.end();
      expect(await stand.code).toBe(0);
      await bot.called(2);
      expect(bot.calls[1].text).toStrictEqual(`${HEAD}\n⌛ сессия закрыта`);
      expect(bot.calls[1].buttons).toStrictEqual([]);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R2b-7: запись в stdout не удалась — «не доставлено: сессия без канала», вопрос активен", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const stand = await registered(back, {
        write: (text) =>
          text.includes("notifications/claude/channel")
            ? Promise.reject(new Error("EPIPE"))
            : Promise.resolve(),
      });
      await stop(back, "Какой цвет?");
      await bot.called(1);
      bot.deliver([textUpdate(1, 111, "Синий", 1)]);
      await bot.called(2);
      expect(bot.calls[1].text).toBe("не доставлено: сессия без канала");
      assert(stand.err.some((line) => line.includes("запись не удалась")));
      stand.input.end();
      expect(await stand.code).toBe(0);
      // Вопрос активен до конца сессии: исход — по закрытию канала.
      await bot.called(3);
      expect(bot.calls[2].text).toStrictEqual(`${HEAD}\n⌛ сессия закрыта`);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("копия живого обмена совпадает с каналом спецификаций", async () => {
  expect(
    await readFile(testdata("live-channel-exchange.jsonl"), "utf8"),
  ).toStrictEqual(
    await readFile(
      new URL(
        "../../docs/specs/fixtures/telegram-relay/r2/live-channel-exchange.jsonl",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

it("адрес ядра не разбирается — отказ попытки, а не падение канала; EOF — выход 0", async () => {
  const stand = channel("не адрес", "t");
  for (const line of await liveIn()) stand.input.push(line);
  await stand.said("mpu claude-channel: ядро недоступно или нет токена");
  stand.input.end();
  expect(await stand.code).toBe(0);
});

it("stdin закрыт, пока читался токен — регистрации нет, выход 0", () =>
  withBack(async (back) => {
    const token = Promise.withResolvers<string | undefined>();
    const asked = Promise.withResolvers<void>();
    const stand = channel(back.url, back.token, {
      mainToken: () => {
        asked.resolve();
        return token.promise;
      },
    });
    for (const line of await liveIn()) stand.input.push(line);
    await asked.promise;
    stand.input.end();
    // Токен прочитан уже после конца сессии: соединяться незачем — иначе
    // канал зарегистрировался бы и не вышел по EOF.
    // Канал доходит до конца сессии (EOF → прерывание) раньше, чем
    // приходит токен: цепочка микрозадач, без сна.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    token.resolve(back.token);
    expect(await within(stand.code, 5000, "выход канала")).toBe(0);
    expect(stand.err).toStrictEqual([]);
  }));
