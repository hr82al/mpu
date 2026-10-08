/**
 * Клиент WebSocket против настоящего сервера на петле: рукопожатие и
 * кадры идут байтами через сокет `node:net`, поэтому проверяется весь
 * путь, а не разбор в отрыве от него. Кадры сервер собирает без маски —
 * как ему и предписано RFC 6455, — а значит, правило «клиент маскирует,
 * сервер нет» проверяется обеими сторонами.
 */

import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { ExecError } from "./errors.ts";
import { decodeFrame, OPCODE } from "./frames.ts";
import { listenLoopback } from "@mpu/testing";
import { socketOptions, streamWebSocket } from "./ws.ts";

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
async function serve(status: string, script: Script): Promise<Server> {
  const listener = createServer();
  // Слушатель закрыт без соединения — сценарий кончается отказом, а не
  // ждёт вечно (как `accept()` после `close()`).
  const accepted = Promise.race([
    once(listener, "connection"),
    once(listener, "close").then(() => {
      throw new Error("клиент не подключился");
    }),
  ]);
  const port = await listenLoopback(listener);
  let request = "";
  const done = (async () => {
    const [conn]: Socket[] = await accepted;
    try {
      const read = reader(conn);
      request = decoder.decode((await read()) ?? new Uint8Array());
      await write(conn, encoder.encode(`${status}\r\n\r\n`));
      await script({ send: (frame) => write(conn, frame), read });
    } finally {
      conn.destroy();
    }
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

/** Куски от клиента по порядку прихода; после конца — `null` навсегда. */
function reader(conn: Socket): () => Promise<Uint8Array | null> {
  const arrived: (Uint8Array | null)[] = [];
  let wake = () => {};
  conn.on("data", (chunk: Buffer) => {
    arrived.push(new Uint8Array(chunk));
    wake();
  });
  conn.on("close", () => {
    arrived.push(null);
    wake();
  });
  return async () => {
    while (arrived.length === 0) {
      await new Promise<void>((resolve) => (wake = resolve));
    }
    const next = arrived[0];
    if (next !== null) arrived.shift();
    return next;
  };
}

function write(conn: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    conn.write(bytes, (err) =>
      err === undefined || err === null ? resolve() : reject(err),
    ),
  );
}

const OK = "HTTP/1.1 101 Switching Protocols";

it("рукопожатие: свои заголовки и ключ", async () => {
  const server = await serve(OK, (session) => session.send(CLOSE));
  try {
    await streamWebSocket({
      url: server.url,
      headers: { "X-API-Key": "секрет" },
      insecure: false,
      onData: () => Promise.resolve(),
    });
    const request = server.request();
    expect(
      request.startsWith("GET /api/websocket/exec?id=x HTTP/1.1"),
      request,
    ).toBe(true);
    for (const line of [
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "X-API-Key: секрет",
    ]) {
      expect(request.includes(line), line).toBe(true);
    }
    // Ключ — 16 случайных байт в base64: ровно 24 символа с хвостом «==».
    expect(/Sec-WebSocket-Key: \S{22}==/.test(request), request).toBe(true);
  } finally {
    await server.stop();
  }
});

it("данные приходят по мере поступления и в порядке", async () => {
  const server = await serve(OK, async (session) => {
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
      onData: (chunk) => {
        seen.push(decoder.decode(chunk));
        return Promise.resolve();
      },
    });
    expect(seen.join("")).toBe("раз\nдва\n");
  } finally {
    await server.stop();
  }
});

it("кадр, разорванный на два куска, собирается", async () => {
  const frame = serverFrame(OPCODE.binary, encoder.encode("склейка"));
  const server = await serve(OK, async (session) => {
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
      onData: (chunk) => {
        seen.push(decoder.decode(chunk));
        return Promise.resolve();
      },
    });
    expect(seen.join("")).toBe("склейка");
  } finally {
    await server.stop();
  }
});

it("на ping сервера уходит pong с той же нагрузкой", async () => {
  let answer: Uint8Array | null = null;
  const server = await serve(OK, async (session) => {
    await session.send(serverFrame(OPCODE.ping, encoder.encode("ау")));
    answer = await session.read();
    await session.send(CLOSE);
  });
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => Promise.resolve(),
    });
  } finally {
    await server.stop();
  }
  const cut = decodeFrame(answer ?? new Uint8Array());
  expect(cut?.frame.opcode).toStrictEqual(OPCODE.pong);
  expect(decoder.decode(cut?.frame.payload)).toBe("ау");
});

it("в простое клиент шлёт ping", async () => {
  let answer: Uint8Array | null = null;
  const server = await serve(OK, async (session) => {
    // Сервер молчит: единственное, что может прийти, — ping простоя.
    answer = await session.read();
    await session.send(CLOSE);
  });
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => Promise.resolve(),
      // Пауза простоя — параметр: продуктовые 30 секунд тест ждал бы
      // стеной, а сравнивать всё равно нечего, кроме самого кадра.
      pingIntervalMs: 1,
    });
  } finally {
    await server.stop();
  }
  expect(decodeFrame(answer ?? new Uint8Array())?.frame.opcode).toStrictEqual(
    OPCODE.ping,
  );
});

it("ответ не 101 — ошибка транспорта со статус-строкой", async () => {
  const server = await serve("HTTP/1.1 403 Forbidden", () => Promise.resolve());
  try {
    const failure = streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => Promise.resolve(),
    });
    await expect(failure).rejects.toThrow(ExecError);
    await expect(failure).rejects.toThrow(
      "WebSocket отклонён: HTTP/1.1 403 Forbidden",
    );
  } finally {
    await server.stop();
  }
});

it("отмена закрывает канал и завершает стрим", async () => {
  const controller = new AbortController();
  const server = await serve(OK, async (session) => {
    await session.send(serverFrame(OPCODE.binary, encoder.encode("тик")));
    // Кадра закрытия сервер не шлёт: завершить стрим обязана отмена.
    await session.read();
  });
  try {
    await streamWebSocket({
      url: server.url,
      headers: {},
      insecure: false,
      onData: () => {
        controller.abort();
        return Promise.resolve();
      },
      signal: controller.signal,
    });
  } finally {
    await server.stop();
  }
});

describe("опции сокета: SNI шлётся только доменному имени", () => {
  it("литеральный v4-адрес — servername'а нет вовсе", () => {
    const options = socketOptions(new URL("https://192.168.150.12:9443"), true);
    expect(options.kind).toBe("tls");
    if (options.kind !== "tls") return;
    // Ключа нет, а не пустая строка: `node:tls` отвергает адрес в SNI
    // раньше всякого обмена с сервером, и exec не доходит до контейнера.
    expect("servername" in options.tls).toBe(false);
    expect(options.tls.host).toBe("192.168.150.12");
    expect(options.tls.port).toBe(9443);
    expect(options.tls.rejectUnauthorized).toBe(false);
  });

  it("литеральный v6-адрес — тоже без SNI", () => {
    const options = socketOptions(new URL("wss://[2001:db8::1]/ws"), false);
    expect(options.kind).toBe("tls");
    if (options.kind !== "tls") return;
    expect("servername" in options.tls).toBe(false);
    expect(options.tls.rejectUnauthorized).toBe(true);
  });

  it("доменное имя — SNI равен хосту", () => {
    const options = socketOptions(
      new URL("https://portainer.example/ws"),
      true,
    );
    expect(options.kind).toBe("tls");
    if (options.kind !== "tls") return;
    expect(options.tls.servername).toBe("portainer.example");
    expect(options.tls.port).toBe(443);
  });

  it("без TLS опции сокета вовсе не про SNI", () => {
    const options = socketOptions(new URL("http://10.0.0.1:8080/ws"), false);
    expect(options).toStrictEqual({
      kind: "tcp",
      tcp: { host: "10.0.0.1", port: 8080 },
    });
  });
});
