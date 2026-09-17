/**
 * Транспорт Bot API (`docs/specs/telegram-log.md`): запрос, разбор
 * ответа и раскладка отказов. Сервер поднимается на петле — наружу
 * тесты не ходят (`ts/CLAUDE.md`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import type { BotConfig } from "./bot_config.ts";
import { type BotMessage, sendBotMessage } from "./bot.ts";

const CONFIG: BotConfig = { token: "8123:AAH", chatId: 987654321 };

/** Текстовое сообщение: самая частая ветка в тестах отказов. */
function text(value: string): BotMessage {
  return { kind: "text", text: value };
}

/** Документ с подписью; содержимое файла — текст, тело читается строкой. */
function document(caption: string, name: string, body: string): BotMessage {
  return {
    kind: "document",
    caption,
    file: { name, bytes: new TextEncoder().encode(body) },
  };
}

/** Сервер на петле: отдаёт заготовленный ответ и записывает запрос. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  try {
    await run(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("успешная отправка — номер сообщения из ответа", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 5000001 } }),
      ),
    async (base) => {
      const sent = await sendBotMessage(CONFIG, text("привет"), base);
      assertEquals(sent.id, 5000001);
    },
  );
});

Deno.test("запрос несёт токен в пути и адресата в теле", async () => {
  let seenPath = "";
  let seenBody: unknown = null;
  await withServer(
    async (request) => {
      seenPath = new URL(request.url).pathname;
      seenBody = await request.json();
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
      );
    },
    async (base) => {
      await sendBotMessage(CONFIG, text("текст"), base);
    },
  );
  assertEquals(seenPath, "/bot8123:AAH/sendMessage");
  assertEquals(seenBody, { chat_id: 987654321, text: "текст" });
});

Deno.test("файл уходит документом: sendDocument и multipart-тело", async () => {
  let seenPath = "";
  let seenType = "";
  let seenBody = "";
  await withServer(
    async (request) => {
      seenPath = new URL(request.url).pathname;
      seenType = request.headers.get("content-type") ?? "";
      seenBody = await request.text();
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 5000002 } }),
      );
    },
    async (base) => {
      const sent = await sendBotMessage(
        CONFIG,
        document("разбор за среду", "разбор.md", "# разбор\n"),
        base,
      );
      assertEquals(sent.id, 5000002);
    },
  );
  // Метод другой: у sendMessage файла нет вовсе.
  assertEquals(seenPath, "/bot8123:AAH/sendDocument");
  const prefix = "multipart/form-data; boundary=";
  assertEquals(seenType.startsWith(prefix), true, `тип части: ${seenType}`);
  const boundary = seenType.slice(prefix.length);
  assertEquals(
    seenBody,
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="chat_id"',
      "",
      "987654321",
      `--${boundary}`,
      'Content-Disposition: form-data; name="caption"',
      "",
      "разбор за среду",
      `--${boundary}`,
      'Content-Disposition: form-data; name="document"; filename="разбор.md"',
      "Content-Type: text/markdown",
      "",
      "# разбор\n",
      `--${boundary}--`,
    ].join("\r\n"),
  );
});

Deno.test("документ уходит под базовым именем, а не под путём", async () => {
  let seenBody = "";
  await withServer(
    async (request) => {
      seenBody = await request.text();
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
      );
    },
    async (base) => {
      // Имя выбирает разбор ввода; транспорт обязан слать его как есть,
      // а не подставлять что-то своё.
      await sendBotMessage(CONFIG, document("", "разбор.md", "x"), base);
    },
  );
  assertEquals(seenBody.includes('filename="разбор.md"'), true);
  assertEquals(seenBody.includes("/home/"), false);
});

Deno.test("пустая подпись — части caption в теле нет вовсе", async () => {
  let seenBody = "";
  await withServer(
    async (request) => {
      seenBody = await request.text();
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1 } }),
      );
    },
    async (base) => {
      await sendBotMessage(CONFIG, document("", "a.md", "x"), base);
    },
  );
  assertEquals(seenBody.includes("caption"), false);
});

Deno.test("ok:true без номера сообщения — явный отказ, а не молчаливый успех", async () => {
  await withServer(
    () => new Response(JSON.stringify({ ok: true, result: {} })),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, text("x"), base),
        DomainError,
      );
      assertEquals(err.message, "telegram: bot API не сообщил номер сообщения");
    },
  );
});

Deno.test("ok:false — код и описание в сообщении отказа", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: message is too long",
        }),
        { status: 400 },
      ),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, text("x"), base),
        DomainError,
      );
      assertEquals(
        err.message,
        "telegram: bot API 400 Bad Request: message is too long",
      );
    },
  );
});

Deno.test("403 — подсказка написать боту, с именем из конфигурации", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        }),
        { status: 403 },
      ),
    async (base) => {
      const err = await assertRejects(
        () =>
          sendBotMessage(
            { ...CONFIG, botName: "my_notes_bot" },
            text("x"),
            base,
          ),
        DomainError,
      );
      assertEquals(
        err.message,
        "telegram: bot API 403 Forbidden: bot was blocked by the user; напиши боту @my_notes_bot /start",
      );
    },
  );
});

Deno.test("chat not found — та же подсказка без имени, если оно не задано", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found",
        }),
        { status: 400 },
      ),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, text("x"), base),
        DomainError,
      );
      assertEquals(
        err.message,
        "telegram: bot API 400 Bad Request: chat not found; напиши боту /start",
      );
    },
  );
});

Deno.test("тело не разбирается как JSON — отказ, а не молчаливый успех", async () => {
  await withServer(
    () => new Response("<html>502</html>", { status: 502 }),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, text("x"), base),
        DomainError,
      );
      assertEquals(
        err.message.startsWith("telegram: bot API вернул не JSON"),
        true,
      );
      // Токен лежит в пути запроса, и текст чужого тела мог бы принести
      // его обратно: инвариант спеки — токена нет ни в выводе, ни в
      // ошибке, ни в журнале (`docs/specs/telegram-log.md`).
      assertEquals(err.message.includes(CONFIG.token), false);
    },
  );
});

Deno.test("сервер недоступен — причина одной строкой", async () => {
  // Порт заведомо закрыт: сервер поднят и сразу остановлен.
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(""),
  );
  const base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  await server.shutdown();
  const err = await assertRejects(
    () => sendBotMessage(CONFIG, text("x"), base),
    DomainError,
  );
  assertEquals(err.message.startsWith("telegram: bot API недоступен: "), true);
  assertEquals(err.message.includes("\n"), false);
  // Причина отказа приходит от рантайма, и исторически в ней бывал
  // полный URL — а он содержит токен. Инвариант спеки закрепляется
  // здесь, чтобы апгрейд рантайма не сломал его молча.
  assertEquals(err.message.includes(CONFIG.token), false);
});

// Проброс `proxy` до клиента проверяется именно через непринятую схему:
// на петле его не проверить — клиент Deno для loopback прокси обходит,
// и вызов уходит напрямую, каким бы ни было значение.
Deno.test("прокси не принят клиентом — отказ называет само значение", async () => {
  await withServer(
    () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    async (base) => {
      const err = await assertRejects(
        () =>
          sendBotMessage(
            { ...CONFIG, proxy: "socks4://127.0.0.1:1080" },
            text("x"),
            base,
          ),
        DomainError,
      );
      assertEquals(
        err.message.startsWith(
          "telegram: bot API недоступен: прокси не принят клиентом",
        ),
        true,
      );
    },
  );
});
