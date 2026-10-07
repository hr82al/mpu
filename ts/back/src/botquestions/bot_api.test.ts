/**
 * Стык Bot API (`docs/specs/platform/telegram-questions.md`, «Стык Bot
 * API», «Ошибки»): тела запросов и разбор ответов по голденам
 * `testdata/` (копии `fixtures/telegram-relay/bot-api/`). Сервер — на
 * петле, наружу тесты не ходят.
 */

import { assert, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BotFailure, HttpBotApi } from "./bot_api.ts";
import { type Inbox, type Sender, SinceStart } from "./updates.ts";
import { serveLoopback } from "../exec/testserve.ts";

const TOKEN = "8123:AAH";

function golden(name: string): string {
  return readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8");
}

/** Запрос, увиденный сервером. */
interface Seen {
  path: string;
  body: unknown;
}

/** Сервер на петле с ответом `reply`; что пришло — в `seen`. */
async function withBot(
  reply: string,
  run: (bot: HttpBotApi, seen: Seen) => Promise<void>,
): Promise<void> {
  const seen: Seen = { path: "", body: null };
  const server = await serveLoopback(async (request) => {
    seen.path = new URL(request.url).pathname;
    seen.body = await request.json();
    return new Response(reply);
  });
  const port = server.port;
  try {
    await run(
      new HttpBotApi({
        token: TOKEN,
        chatId: 111,
        apiBase: `http://127.0.0.1:${port}`,
      }),
      seen,
    );
  } finally {
    await server.close();
  }
}

it("sendMessage — кнопки в reply_markup, номер из ответа голдена", async () => {
  await withBot(golden("sendMessage.json"), async (bot, seen) => {
    const id = await bot.send({ text: "вопрос", entities: [] }, [
      [{ text: "Yes", data: "r1:1:0" }, { text: "No", data: "r1:1:1" }],
    ]);
    expect(id).toBe(1546);
    expect(seen.path).toStrictEqual(`/bot${TOKEN}/sendMessage`);
    expect(seen.body).toStrictEqual({
      chat_id: 111,
      text: "вопрос",
      reply_markup: {
        inline_keyboard: [[
          { text: "Yes", callback_data: "r1:1:0" },
          { text: "No", callback_data: "r1:1:1" },
        ]],
      },
    });
  });
});

it("editMessageText без кнопок — поля reply_markup нет", async () => {
  await withBot(golden("editMessageText.json"), async (bot, seen) => {
    await bot.edit(1546, { text: "итог", entities: [] }, []);
    expect(seen.path).toStrictEqual(`/bot${TOKEN}/editMessageText`);
    expect(seen.body).toStrictEqual({
      chat_id: 111,
      message_id: 1546,
      text: "итог",
    });
  });
});

it("выделения — полем entities (UTF-16), нет выделений — поля нет", async () => {
  await withBot(golden("editMessageText.json"), async (bot, seen) => {
    await bot.edit(1546, {
      text: "🖥 probe\nBash command",
      entities: [{ type: "bold", offset: 9, length: 12 }],
    }, []);
    expect(seen.body).toStrictEqual({
      chat_id: 111,
      message_id: 1546,
      text: "🖥 probe\nBash command",
      entities: [{ type: "bold", offset: 9, length: 12 }],
    });
  });
});

// Успешный ответ answerCallbackQuery не снят — догадка спеки.
const ACK_OK = '{"ok":true,"result":true}';

it("answerCallbackQuery — подсказка полем text, пустая — без поля", async () => {
  await withBot(ACK_OK, async (bot, seen) => {
    await bot.ack("141887918370673903", "");
    expect(seen.body).toStrictEqual({
      callback_query_id: "141887918370673903",
    });
    await bot.ack("141887918370673903", "вопрос уже решён");
    expect(seen.body).toStrictEqual({
      callback_query_id: "141887918370673903",
      text: "вопрос уже решён",
    });
  });
});

it("опоздавшее подтверждение — отказ с кодом и описанием голдена", async () => {
  await withBot(golden("answerCallbackQuery-too-old.json"), async (bot) => {
    const err = await bot.ack("1", "").catch((thrown: unknown) => thrown);
    assert(err instanceof BotFailure);
    expect(err.message).toBe(
      "бот недоступен: 400 Bad Request: query is too old and response timeout expired or query ID is invalid",
    );
  });
});

/** Кто прислал словами: владелец `111` в личном чате или нет. */
function who(sender: Sender): string {
  return sender.is(111) ? "владелец" : "чужой";
}

/** Ящик, записывающий доставленное. */
function recorder(): Inbox & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    press: (sender, callback, data) => {
      seen.push(`нажатие ${who(sender)} ${callback} ${data}`);
      return Promise.resolve();
    },
    write: (sender, text) => {
      seen.push(`текст ${who(sender)} ${text}`);
      return Promise.resolve();
    },
  };
}

it("getUpdates — тело опроса и разбор живого голдена", async () => {
  await withBot(
    golden("getUpdates-callbacks-and-text.json"),
    async (bot, seen) => {
      const updates = await bot.updates(
        913156012,
        new AbortController().signal,
      );
      expect(seen.path).toStrictEqual(`/bot${TOKEN}/getUpdates`);
      expect(seen.body).toStrictEqual({
        offset: 913156012,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      expect(updates.map((update) => update.id)).toStrictEqual([
        913156012,
        913156013,
        913156014,
        913156015,
        913156016,
        913156017,
      ]);
      const inbox = recorder();
      for (const update of updates) {
        await update.deliver(inbox, new SinceStart(0));
      }
      expect(inbox.seen).toStrictEqual([
        "нажатие владелец 141887918370673903 q1:0",
        "нажатие владелец 141887919433068132 q1:0",
        "нажатие владелец 141887920662361059 q1:0",
        inbox.seen[3],
        inbox.seen[4],
        "текст владелец Готово. Но не вижу реакций на кнопки",
      ]);
      expect(inbox.seen[3].endsWith(" q1:1")).toBe(true);
      expect(inbox.seen[4].endsWith(" q1:2")).toBe(true);
    },
  );
});

it("ok:false 401 — «бот недоступен: 401 Unauthorized»", async () => {
  await withBot(
    '{"ok":false,"error_code":401,"description":"Unauthorized"}',
    async (bot) => {
      const err = await bot.send({ text: "x", entities: [] }, []).catch((
        thrown: unknown,
      ) => thrown);
      assert(err instanceof BotFailure);
      expect(err.message).toBe("бот недоступен: 401 Unauthorized");
      expect(err.isConflict()).toBe(false);
    },
  );
});

it("409 — второй читатель", async () => {
  await withBot(
    '{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}',
    async (bot) => {
      const err = await bot.updates(0, new AbortController().signal).catch((
        thrown: unknown,
      ) => thrown);
      assert(err instanceof BotFailure);
      expect(err.isConflict()).toBe(true);
    },
  );
});

it("токена нет в причине, даже если его повторило тело ответа", async () => {
  await withBot(
    `{"ok":false,"error_code":404,"description":"Not Found: /bot${TOKEN}/x"}`,
    async (bot) => {
      const err = await bot.send({ text: "x", entities: [] }, []).catch((
        thrown: unknown,
      ) => thrown);
      assert(err instanceof BotFailure);
      expect(err.message.includes(TOKEN), err.message).toBe(false);
    },
  );
  await withBot(`<html>/bot${TOKEN}</html>`, async (bot) => {
    const err = await bot.send({ text: "x", entities: [] }, []).catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof BotFailure);
    expect(err.message.startsWith("бот недоступен: ответ не JSON")).toBe(true);
    expect(err.message.includes(TOKEN), err.message).toBe(false);
  });
});

it("сеть недоступна — причина одной строкой, без токена", async () => {
  const server = await serveLoopback(() => new Response(""));
  const port = server.port;
  await server.close();
  const bot = new HttpBotApi({
    token: TOKEN,
    chatId: 111,
    apiBase: `http://127.0.0.1:${port}`,
  });
  const err = await bot.send({ text: "x", entities: [] }, []).catch((
    thrown: unknown,
  ) => thrown);
  assert(err instanceof BotFailure);
  expect(err.message.startsWith("бот недоступен: ")).toBe(true);
  expect(err.message.includes("\n")).toBe(false);
  expect(err.message.includes(TOKEN), err.message).toBe(false);
});

it("опрос прерывается сигналом остановки", async () => {
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  const server = await serveLoopback(async () => {
    arrived.resolve();
    await release.promise;
    return new Response('{"ok":true,"result":[]}');
  });
  const port = server.port;
  try {
    const bot = new HttpBotApi({
      token: TOKEN,
      chatId: 111,
      apiBase: `http://127.0.0.1:${port}`,
    });
    const stop = new AbortController();
    const polling = bot.updates(0, stop.signal);
    await arrived.promise;
    stop.abort();
    await expect(polling).rejects.toThrow(BotFailure);
  } finally {
    release.resolve();
    await server.close();
  }
});
