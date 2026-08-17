/**
 * Клиент WebSocket против настоящего сервера на петле: рукопожатие и
 * кадры идут байтами через сокет `node:net`, поэтому проверяется весь
 * путь, а не разбор в отрыве от него. Кадры сервер собирает без маски —
 * как ему и предписано RFC 6455, — а значит, правило «клиент маскирует,
 * сервер нет» проверяется обеими сторонами.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { decodeFrame, OPCODE } from "./frames.ts";
import { streamWebSocket } from "./ws.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Кадр сервера: без маски (RFC 6455). */
function serverFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = 0x80 | opcode;
  out[1] = payload.length;
  out.set(payload, 2);
  return out;
}

const CLOSE = serverFrame(OPCODE.close, new Uint8Array());

/** Соединение глазами сценария сервера. */
interface Session {
  readonly send: (frame: Uint8Array) => Promise<void>;
  /** Следующий кусок от клиента; EOF — `null`. */
  readonly read: () => Promise<Uint8Array | null>;
}

type Script = (session: Session) => Promise<void>;

interface Server {
  readonly url: URL;
  /** Текст рукопожатия клиента. */
  readonly request: () => string;
  /** Закрывает слушателя и дожидается сценария. */
  readonly stop: () => Promise<void>;
}

/**
 * Сервер на одно соединение: читает рукопожатие, отвечает статусной
 * строкой и отдаёт соединение сценарию. Ждать чего-либо паузами не
 * нужно — сценарий ждёт байты, а они приходят событием.
 */
function serve(status: string, script: Script): Server {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  let request = "";
  const done = (async () => {
    using conn = await listener.accept();
    const buffer = new Uint8Array(8192);
    const read = async () => {
      const count = await conn.read(buffer);
      return count === null ? null : buffer.slice(0, count);
    };
    request = decoder.decode(await read() ?? new Uint8Array());
    await conn.write(encoder.encode(`${status}\r\n\r\n`));
    await script({
      send: async (frame) => {
        await conn.write(frame);
      },
      read,
    });
  })();
  return {
    url: new URL(`http://127.0.0.1:${port}/api/websocket/exec?id=x`),
    request: () => request,
    stop: async () => {
      listener.close();
      await done.catch(() => {});
    },
  };
}

const OK = "HTTP/1.1 101 Switching Protocols";

Deno.test("рукопожатие: свои заголовки и ключ", async () => {
  const server = serve(OK, (session) => session.send(CLOSE));
  try {
    await streamWebSocket({
      url: server.url,
      headers: { "X-API-Key": "секрет" },
      insecure: false,
      onData: () => {},
    });
    const request = server.request();
    assertEquals(
      request.startsWith("GET /api/websocket/exec?id=x HTTP/1.1"),
      true,
      request,
    );
    for (
      const line of [
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "X-API-Key: секрет",
      ]
    ) {
      assertEquals(request.includes(line), true, line);
    }
    // Ключ — 16 случайных байт в base64: ровно 24 символа с хвостом «==».
    assertEquals(/Sec-WebSocket-Key: \S{22}==/.test(request), true, request);
  } finally {
    await server.stop();
  }
});

Deno.test("данные приходят по мере поступления и в порядке", async () => {
  const server = serve(OK, async (session) => {
    await session.send(serverFrame(OPCODE.binary, encoder.encode("раз\n")));
    await session.send(serverFrame(OPCODE.binary, encoder.encode("два\n")));
    await session.send(CLOSE);
  });
  const seen: string[] = [];
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: (chunk) => seen.push(decoder.decode(chunk)),
    });
    assertEquals(seen.join(""), "раз\nдва\n");
  } finally {
    await server.stop();
  }
});

Deno.test("кадр, разорванный на два куска, собирается", async () => {
  const frame = serverFrame(OPCODE.binary, encoder.encode("склейка"));
  const server = serve(OK, async (session) => {
    await session.send(frame.subarray(0, 3));
    await session.send(frame.subarray(3));
    await session.send(CLOSE);
  });
  const seen: string[] = [];
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: (chunk) => seen.push(decoder.decode(chunk)),
    });
    assertEquals(seen.join(""), "склейка");
  } finally {
    await server.stop();
  }
});

Deno.test("на ping сервера уходит pong с той же нагрузкой", async () => {
  let answer: Uint8Array | null = null;
  const server = serve(OK, async (session) => {
    await session.send(serverFrame(OPCODE.ping, encoder.encode("ау")));
    answer = await session.read();
    await session.send(CLOSE);
  });
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => {},
    });
  } finally {
    await server.stop();
  }
  const cut = decodeFrame(answer ?? new Uint8Array());
  assertEquals(cut?.frame.opcode, OPCODE.pong);
  assertEquals(decoder.decode(cut?.frame.payload), "ау");
});

Deno.test("в простое клиент шлёт ping", async () => {
  let answer: Uint8Array | null = null;
  const server = serve(OK, async (session) => {
    // Сервер молчит: единственное, что может прийти, — ping простоя.
    answer = await session.read();
    await session.send(CLOSE);
  });
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => {},
      // Пауза простоя — параметр: продуктовые 30 секунд тест ждал бы
      // стеной, а сравнивать всё равно нечего, кроме самого кадра.
      pingIntervalMs: 1,
    });
  } finally {
    await server.stop();
  }
  assertEquals(
    decodeFrame(answer ?? new Uint8Array())?.frame.opcode,
    OPCODE.ping,
  );
});

Deno.test("ответ не 101 — ошибка транспорта со статус-строкой", async () => {
  const server = serve("HTTP/1.1 403 Forbidden", () => Promise.resolve());
  try {
    await assertRejects(
      () =>
        streamWebSocket({
          url: server.url,
          headers: {},
          insecure: false,
          onData: () => {},
        }),
      DomainError,
      "WebSocket отклонён: HTTP/1.1 403 Forbidden",
    );
  } finally {
    await server.stop();
  }
});

Deno.test("отмена закрывает канал и завершает стрим", async () => {
  const controller = new AbortController();
  const server = serve(OK, async (session) => {
    await session.send(serverFrame(OPCODE.binary, encoder.encode("тик")));
    // Кадра закрытия сервер не шлёт: завершить стрим обязана отмена.
    await session.read();
  });
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => controller.abort(),
      signal: controller.signal,
    });
  } finally {
    await server.stop();
  }
});
