/**
 * HTTP-сервер тестов на петле поверх `node:http` с веб-обработчиком
 * `Request → Response` — то, что тесты брали у `Deno.serve` (порт 0,
 * `127.0.0.1`), без привязки к рантайму.
 */

import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:net";

export interface LoopbackServer {
  /** Порт, выданный системой. */
  readonly port: number;
  /** Обрывает соединения и дожидается закрытия. */
  close(): Promise<void>;
}

export type WebHandler = (request: Request) => Response | Promise<Response>;

/** Ставит `server` слушать свободный порт `127.0.0.1`; ответ — порт. */
export async function listenLoopback(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`адрес петли не порт: ${address}`);
  }
  return address.port;
}

/** Слушает свободный порт `127.0.0.1`; отказ обработчика — ответ 500. */
export async function serveLoopback(
  handle: WebHandler,
): Promise<LoopbackServer> {
  // Ждать ответа некому: запрос живёт в `node:http`, `answer` не отвергается.
  const server = createServer((incoming, outgoing) => {
    answer(incoming, outgoing, handle).catch((err) => outgoing.destroy(err));
  });
  return {
    port: await listenLoopback(server),
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

async function answer(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handle: WebHandler,
): Promise<void> {
  try {
    const response = await handle(await requestOf(incoming));
    const body = Buffer.from(await response.arrayBuffer());
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") outgoing.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
    outgoing.writeHead(response.status);
    outgoing.end(body);
  } catch (err) {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end(String(err));
  }
}

async function requestOf(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
  }
  const method = incoming.method ?? "GET";
  const bodyless = method === "GET" || method === "HEAD";
  return new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
    method,
    headers,
    body: bodyless ? undefined : Buffer.concat(chunks),
  });
}
