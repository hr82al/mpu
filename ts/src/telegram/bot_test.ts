/**
 * Транспорт Bot API (`docs/specs/telegram-log.md`): запрос, разбор
 * ответа и раскладка отказов. Сервер поднимается на петле — наружу
 * тесты не ходят (`ts/CLAUDE.md`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import type { BotConfig } from "./bot_config.ts";
import { sendBotMessage } from "./bot.ts";

const CONFIG: BotConfig = { token: "8123:AAH", chatId: 987654321 };

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
      const sent = await sendBotMessage(CONFIG, "привет", base);
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
      await sendBotMessage(CONFIG, "текст", base);
    },
  );
  assertEquals(seenPath, "/bot8123:AAH/sendMessage");
  assertEquals(seenBody, { chat_id: 987654321, text: "текст" });
});

Deno.test("ok:true без номера сообщения — явный отказ, а не молчаливый успех", async () => {
  await withServer(
    () => new Response(JSON.stringify({ ok: true, result: {} })),
    async (base) => {
      const err = await assertRejects(
        () => sendBotMessage(CONFIG, "x", base),
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
        () => sendBotMessage(CONFIG, "x", base),
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
        () => sendBotMessage({ ...CONFIG, botName: "my_notes_bot" }, "x", base),
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
        () => sendBotMessage(CONFIG, "x", base),
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
        () => sendBotMessage(CONFIG, "x", base),
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
    () => sendBotMessage(CONFIG, "x", base),
    DomainError,
  );
  assertEquals(err.message.startsWith("telegram: bot API недоступен: "), true);
  assertEquals(err.message.includes("\n"), false);
  // Причина отказа приходит от рантайма, и исторически в ней бывал
  // полный URL — а он содержит токен. Инвариант спеки закрепляется
  // здесь, чтобы апгрейд рантайма не сломал его молча.
  assertEquals(err.message.includes(CONFIG.token), false);
});
