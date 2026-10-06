/**
 * Стык Bot API (`docs/specs/platform/telegram-questions.md`, «Стык Bot
 * API», «Ошибки»): тела запросов и разбор ответов по голденам
 * `testdata/` (копии `fixtures/telegram-relay/bot-api/`). Сервер — на
 * петле, наружу тесты не ходят.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { BotFailure, HttpBotApi } from "./bot_api.ts";
import { type Inbox, type Sender, SinceStart } from "./updates.ts";

const TOKEN = "8123:AAH";

function golden(name: string): string {
  return Deno.readTextFileSync(new URL(`./testdata/${name}`, import.meta.url));
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
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      seen.path = new URL(request.url).pathname;
      seen.body = await request.json();
      return new Response(reply);
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
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
    await server.shutdown();
  }
}

Deno.test("sendMessage — кнопки в reply_markup, номер из ответа голдена", async () => {
  await withBot(golden("sendMessage.json"), async (bot, seen) => {
    const id = await bot.send("вопрос", [
      [{ text: "Yes", data: "r1:1:0" }, { text: "No", data: "r1:1:1" }],
    ]);
    assertEquals(id, 1546);
    assertEquals(seen.path, `/bot${TOKEN}/sendMessage`);
    assertEquals(seen.body, {
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

Deno.test("editMessageText без кнопок — поля reply_markup нет", async () => {
  await withBot(golden("editMessageText.json"), async (bot, seen) => {
    await bot.edit(1546, "итог", []);
    assertEquals(seen.path, `/bot${TOKEN}/editMessageText`);
    assertEquals(seen.body, { chat_id: 111, message_id: 1546, text: "итог" });
  });
});

// Успешный ответ answerCallbackQuery не снят — догадка спеки.
const ACK_OK = '{"ok":true,"result":true}';

Deno.test("answerCallbackQuery — подсказка полем text, пустая — без поля", async () => {
  await withBot(ACK_OK, async (bot, seen) => {
    await bot.ack("141887918370673903", "");
    assertEquals(seen.body, { callback_query_id: "141887918370673903" });
    await bot.ack("141887918370673903", "вопрос уже решён");
    assertEquals(seen.body, {
      callback_query_id: "141887918370673903",
      text: "вопрос уже решён",
    });
  });
});

Deno.test("опоздавшее подтверждение — отказ с кодом и описанием голдена", async () => {
  await withBot(golden("answerCallbackQuery-too-old.json"), async (bot) => {
    const err = await assertRejects(() => bot.ack("1", ""), BotFailure);
    assertEquals(
      err.message,
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

Deno.test("getUpdates — тело опроса и разбор живого голдена", async () => {
  await withBot(
    golden("getUpdates-callbacks-and-text.json"),
    async (bot, seen) => {
      const updates = await bot.updates(
        913156012,
        new AbortController().signal,
      );
      assertEquals(seen.path, `/bot${TOKEN}/getUpdates`);
      assertEquals(seen.body, {
        offset: 913156012,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      assertEquals(updates.map((update) => update.id), [
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
      assertEquals(inbox.seen, [
        "нажатие владелец 141887918370673903 q1:0",
        "нажатие владелец 141887919433068132 q1:0",
        "нажатие владелец 141887920662361059 q1:0",
        inbox.seen[3],
        inbox.seen[4],
        "текст владелец Готово. Но не вижу реакций на кнопки",
      ]);
      assertEquals(inbox.seen[3].endsWith(" q1:1"), true);
      assertEquals(inbox.seen[4].endsWith(" q1:2"), true);
    },
  );
});

Deno.test("ok:false 401 — «бот недоступен: 401 Unauthorized»", async () => {
  await withBot(
    '{"ok":false,"error_code":401,"description":"Unauthorized"}',
    async (bot) => {
      const err = await assertRejects(() => bot.send("x", []), BotFailure);
      assertEquals(err.message, "бот недоступен: 401 Unauthorized");
      assertEquals(err.isConflict(), false);
    },
  );
});

Deno.test("409 — второй читатель", async () => {
  await withBot(
    '{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}',
    async (bot) => {
      const err = await assertRejects(
        () => bot.updates(0, new AbortController().signal),
        BotFailure,
      );
      assertEquals(err.isConflict(), true);
    },
  );
});

Deno.test("токена нет в причине, даже если его повторило тело ответа", async () => {
  await withBot(
    `{"ok":false,"error_code":404,"description":"Not Found: /bot${TOKEN}/x"}`,
    async (bot) => {
      const err = await assertRejects(() => bot.send("x", []), BotFailure);
      assertEquals(err.message.includes(TOKEN), false, err.message);
    },
  );
  await withBot(`<html>/bot${TOKEN}</html>`, async (bot) => {
    const err = await assertRejects(() => bot.send("x", []), BotFailure);
    assertEquals(err.message.startsWith("бот недоступен: ответ не JSON"), true);
    assertEquals(err.message.includes(TOKEN), false, err.message);
  });
});

Deno.test("сеть недоступна — причина одной строкой, без токена", async () => {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(""),
  );
  const port = (server.addr as Deno.NetAddr).port;
  await server.shutdown();
  const bot = new HttpBotApi({
    token: TOKEN,
    chatId: 111,
    apiBase: `http://127.0.0.1:${port}`,
  });
  const err = await assertRejects(() => bot.send("x", []), BotFailure);
  assertEquals(err.message.startsWith("бот недоступен: "), true);
  assertEquals(err.message.includes("\n"), false);
  assertEquals(err.message.includes(TOKEN), false, err.message);
});

Deno.test("опрос прерывается сигналом остановки", async () => {
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async () => {
      arrived.resolve();
      await release.promise;
      return new Response('{"ok":true,"result":[]}');
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
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
    await assertRejects(() => polling, BotFailure);
  } finally {
    release.resolve();
    await server.shutdown();
  }
});
