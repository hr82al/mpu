/**
 * Транспорт Bot API (`docs/specs/telegram-log.md`): запрос, разбор
 * ответа и раскладка отказов. Сервер поднимается на петле — наружу
 * тесты не ходят (`ts/CLAUDE.md`).
 */

import { createServer } from "node:http";
import { assert, expect, it } from "vitest";
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

/** Поднятый на петле сервер: адрес и остановка. */
type Loopback = { base: string; stop: () => Promise<void> };

/** Слушает `127.0.0.1` на свободном порту; `handler` отвечает как fetch-обработчик. */
async function listen(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<Loopback> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", (err) => res.writeHead(400).end(String(err)));
    req.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = req.method ?? "GET";
      const request = new Request(
        `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`,
        {
          method,
          headers,
          body: method === "GET" || method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
        },
      );
      // Отказ обработчика — ответ 500, как у `Deno.serve`: клиент получает
      // ответ, а тест краснеет на нём, а не на пределе времени.
      Promise.resolve(handler(request)).then(async (response) => {
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        );
        res.end(Buffer.from(await response.arrayBuffer()));
      }).catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert(addr !== null && typeof addr === "object", "нет адреса сервера");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
        server.closeAllConnections();
      }),
  };
}

/** Сервер на петле: отдаёт заготовленный ответ и записывает запрос. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const loopback = await listen(handler);
  try {
    await run(loopback.base);
  } finally {
    await loopback.stop();
  }
}

it("успешная отправка — номер сообщения из ответа", async () => {
  await withServer(
    () =>
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 5000001 } }),
      ),
    async (base) => {
      const sent = await sendBotMessage(CONFIG, text("привет"), base);
      expect(sent.id).toBe(5000001);
    },
  );
});

it("запрос несёт токен в пути и адресата в теле", async () => {
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
  expect(seenPath).toBe("/bot8123:AAH/sendMessage");
  expect(seenBody).toStrictEqual({ chat_id: 987654321, text: "текст" });
});

it("файл уходит документом: sendDocument и multipart-тело", async () => {
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
      expect(sent.id).toBe(5000002);
    },
  );
  // Метод другой: у sendMessage файла нет вовсе.
  expect(seenPath).toBe("/bot8123:AAH/sendDocument");
  const prefix = "multipart/form-data; boundary=";
  expect(seenType.startsWith(prefix), `тип части: ${seenType}`).toBe(true);
  const boundary = seenType.slice(prefix.length);
  expect(seenBody).toStrictEqual([
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
  ].join("\r\n"));
});

it("документ уходит под базовым именем, а не под путём", async () => {
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
  expect(seenBody.includes('filename="разбор.md"')).toBe(true);
  expect(seenBody.includes("/home/")).toBe(false);
});

it("пустая подпись — части caption в теле нет вовсе", async () => {
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
  expect(seenBody.includes("caption")).toBe(false);
});

it("ok:true без номера сообщения — явный отказ, а не молчаливый успех", async () => {
  await withServer(
    () => new Response(JSON.stringify({ ok: true, result: {} })),
    async (base) => {
      const err = await sendBotMessage(CONFIG, text("x"), base).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(err.message).toBe("telegram: bot API не сообщил номер сообщения");
    },
  );
});

it("ok:false — код и описание в сообщении отказа", async () => {
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
      const err = await sendBotMessage(CONFIG, text("x"), base).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(err.message).toBe(
        "telegram: bot API 400 Bad Request: message is too long",
      );
    },
  );
});

it("403 — подсказка написать боту, с именем из конфигурации", async () => {
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
      const err = await sendBotMessage(
        { ...CONFIG, botName: "my_notes_bot" },
        text("x"),
        base,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(err.message).toBe(
        "telegram: bot API 403 Forbidden: bot was blocked by the user; напиши боту @my_notes_bot /start",
      );
    },
  );
});

it("chat not found — та же подсказка без имени, если оно не задано", async () => {
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
      const err = await sendBotMessage(CONFIG, text("x"), base).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(err.message).toBe(
        "telegram: bot API 400 Bad Request: chat not found; напиши боту /start",
      );
    },
  );
});

it("тело не разбирается как JSON — отказ, а не молчаливый успех", async () => {
  await withServer(
    () => new Response("<html>502</html>", { status: 502 }),
    async (base) => {
      const err = await sendBotMessage(CONFIG, text("x"), base).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(err.message.startsWith("telegram: bot API вернул не JSON")).toBe(
        true,
      );
      // Токен лежит в пути запроса, и текст чужого тела мог бы принести
      // его обратно: инвариант спеки — токена нет ни в выводе, ни в
      // ошибке, ни в журнале (`docs/specs/telegram-log.md`).
      expect(err.message.includes(CONFIG.token)).toBe(false);
    },
  );
});

it("сервер недоступен — причина одной строкой", async () => {
  // Порт заведомо закрыт: сервер поднят и сразу остановлен.
  const loopback = await listen(() => new Response(""));
  const base = loopback.base;
  await loopback.stop();
  const err = await sendBotMessage(CONFIG, text("x"), base).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof DomainError, "ожидался отказ DomainError");
  expect(err.message.startsWith("telegram: bot API недоступен: ")).toBe(true);
  expect(err.message.includes("\n")).toBe(false);
  // Причина отказа приходит от рантайма, и исторически в ней бывал
  // полный URL — а он содержит токен. Инвариант спеки закрепляется
  // здесь, чтобы апгрейд рантайма не сломал его молча.
  expect(err.message.includes(CONFIG.token)).toBe(false);
});

// Проброс `proxy` до клиента проверяется именно через непринятую схему:
// на петле его не проверить — клиент Deno для loopback прокси обходит,
// и вызов уходит напрямую, каким бы ни было значение.
it("прокси не принят клиентом — отказ называет само значение", async () => {
  await withServer(
    () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    async (base) => {
      const err = await sendBotMessage(
        { ...CONFIG, proxy: "socks4://127.0.0.1:1080" },
        text("x"),
        base,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(err.message.startsWith(
        "telegram: bot API недоступен: прокси не принят клиентом",
      )).toBe(true);
    },
  );
});

it("прокси не принят клиентом — без учётных данных в отказе", async () => {
  await withServer(
    () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    async (base) => {
      const err = await sendBotMessage(
        { ...CONFIG, proxy: "socks4://u:p'a ss@h:1" },
        text("x"),
        base,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof DomainError, "ожидался отказ DomainError");
      expect(
        err.message.startsWith(
          "telegram: bot API недоступен: прокси не принят клиентом — " +
            "'socks4://h:1': ",
        ),
        err.message,
      ).toBe(true);
    },
  );
});
