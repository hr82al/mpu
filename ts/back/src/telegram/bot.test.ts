/**
 * Транспорт Bot API (`docs/specs/telegram-log.md`): запрос, разбор
 * ответа и раскладка отказов. Сервер поднимается на петле — наружу
 * тесты не ходят (`ts/CLAUDE.md`).
 */

import { Buffer } from "node:buffer";
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import { assert, describe, expect, it } from "vitest";
import { DomainError } from "../command/mod.ts";
import { serveFetch } from "../testing/http.ts";
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
  const loopback = await serveFetch(handler);
  try {
    await run(loopback.baseUrl);
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
  const loopback = await serveFetch(() => new Response(""));
  const base = loopback.baseUrl;
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

// Проброс `proxy` до транспорта проверяется через непринятую схему: отказ
// приходит до сети и называет само значение, а не его подмену.
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

/** Эмулятор SOCKS5 на петле: адреса CONNECT и учётка, с которой вошли. */
interface Socks {
  readonly url: (scheme: string, auth?: string) => string;
  /** `хост:порт` каждого CONNECT — как его назвал клиент. */
  readonly targets: string[];
  readonly logins: string[];
  readonly stop: () => Promise<void>;
}

/**
 * SOCKS5 (RFC 1928, вход по паролю — RFC 1929) ровно в том объёме, что
 * нужен клиенту: приветствие, при пароле — вход, CONNECT по IPv4 или
 * имени. Соединение идёт на `127.0.0.1` того же порта, какое бы имя ни
 * назвали: тест проверяет, что запрос прошёл через прокси, а не DNS.
 */
async function socksProxy(): Promise<Socks> {
  const targets: string[] = [];
  const logins: string[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.on("error", () => client.destroy());
    client.once("data", (greeting: Buffer) => {
      const methods = [...greeting.subarray(2, 2 + greeting[1])];
      if (!methods.includes(2)) {
        client.write(Buffer.from([5, 0]));
        client.once("data", (request: Buffer) => open(client, request));
        return;
      }
      client.write(Buffer.from([5, 2]));
      client.once("data", (login: Buffer) => {
        const user = login.subarray(2, 2 + login[1]);
        const at = 2 + login[1];
        logins.push(`${user}:${login.subarray(at + 1, at + 1 + login[at])}`);
        client.write(Buffer.from([1, 0]));
        client.once("data", (request: Buffer) => open(client, request));
      });
    });
  });
  function open(client: Socket, request: Buffer): void {
    const byName = request[3] === 3;
    const end = byName ? 5 + request[4] : 8;
    const host = byName
      ? request.subarray(5, end).toString()
      : [...request.subarray(4, 8)].join(".");
    const port = request.readUInt16BE(end);
    targets.push(`${host}:${port}`);
    const upstream = connect(port, "127.0.0.1", () => {
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (scheme, auth) =>
      `${scheme}://${auth === undefined ? "" : `${auth}@`}127.0.0.1:${port}`,
    targets,
    logins,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("прокси socks5 — запрос Bot API доходит через него", () => {
  // `docs/specs/telegram-log.md`, «Конфигурация»: схемы Bot API —
  // http/https/socks5/socks5h. У `socks5` имя адреса разрешает клиент, у
  // `socks5h` — прокси: в CONNECT уходит само имя.
  const cases = [
    ["socks5", "127.0.0.1", undefined],
    ["socks5h", "localhost", undefined],
    ["socks5", "127.0.0.1", "u:p%40ss"],
  ] as const;
  for (const [scheme, host, auth] of cases) {
    const name = `${scheme}${auth === undefined ? "" : " с паролем"}`;
    it(name, async () => {
      const proxy = await socksProxy();
      let seenPath = "";
      try {
        await withServer(
          (request) => {
            seenPath = new URL(request.url).pathname;
            return new Response(
              JSON.stringify({ ok: true, result: { message_id: 7 } }),
            );
          },
          async (base) => {
            const port = new URL(base).port;
            const sent = await sendBotMessage(
              { ...CONFIG, proxy: proxy.url(scheme, auth) },
              text("через прокси"),
              `http://${host}:${port}`,
            );
            expect(sent.id).toBe(7);
            expect(proxy.targets, "CONNECT прокси").toStrictEqual([
              `${host}:${port}`,
            ]);
          },
        );
        expect(seenPath).toBe("/bot8123:AAH/sendMessage");
        expect(proxy.logins, "вход в прокси").toStrictEqual(
          auth === undefined ? [] : ["u:p@ss"],
        );
      } finally {
        await proxy.stop();
      }
    });
  }
});
