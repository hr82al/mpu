/**
 * Подставной HTTP-сервер на петле для тестов `*.test.ts`: обработчик в
 * форме `Request → Response`, как у сервера Deno, а сервер — `node:http`
 * (`node:https` с сертификатом), одинаковый под тремя рантаймами (Bun, Node,
 * Deno).
 *
 * Модуль подключают только тесты.
 */

import { Buffer } from "node:buffer";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";

/** Обработчик запроса в форме `Request → Response`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Запущенный сервер. */
export interface FakeHttp {
  /** `http://127.0.0.1:<порт>` (`https://` с сертификатом), без `/`. */
  readonly baseUrl: string;
  readonly port: number;
  /**
   * Перестать принимать соединения и дождаться начатых ответов —
   * как `shutdown` прежнего сервера (Deno). Висящий обработчик тест
   * отпускает до `stop`: при живом клиенте `stop` ждёт его ответа без срока.
   */
  stop(): Promise<void>;
}

/** Сертификат и ключ в PEM: сервер — `https`. */
export interface Tls {
  readonly cert: string;
  readonly key: string;
}

/** Поднимает сервер на `127.0.0.1` и свободном порту. */
export async function serveFetch(
  handler: FetchHandler,
  tls?: Tls,
): Promise<FakeHttp> {
  const scheme = tls === undefined ? "http" : "https";
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    // Сбой записи ответа (клиент ушёл посреди `writeHead`/`write`) —
    // соединение рвётся, ошибка видна в выводе прогона.
    answer(handler, scheme, req, res).catch((err) => {
      console.error(err);
      res.destroy();
    });
  };
  const server: Server =
    tls === undefined
      ? createHttpServer(listener)
      : createHttpsServer({ cert: tls.cert, key: tls.key }, listener);
  const port = await listenLoopback(server);
  return {
    baseUrl: `${scheme}://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        server.closeIdleConnections();
      }),
  };
}

/**
 * Ставит `server` слушать свободный порт `127.0.0.1`; ответ — порт. Для
 * сервера без веб-обработчика: сокет `WebSocket`, занятый порт.
 */
export async function listenLoopback(server: NetServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`адрес петли не порт: ${address}`);
  }
  return address.port;
}

/** Порт петли, на котором заведомо никто не слушает: занят и отпущен. */
export async function closedPort(): Promise<number> {
  const server = createNetServer();
  const port = await listenLoopback(server);
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err === undefined ? resolve() : reject(err))),
  );
  return port;
}

async function answer(
  handler: FetchHandler,
  scheme: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Обрыв клиентом до конца ответа — отмена запроса, как у
  // `request.signal` прежнего сервера (Deno).
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort();
  });
  let response: Response;
  try {
    response = await handler(await requestOf(scheme, req, aborted.signal));
  } catch (err) {
    // Сервер Deno на брошенном из обработчика отвечает 500 и пишет ошибку.
    console.error(err);
    response = new Response("Internal Server Error", { status: 500 });
  }
  res.writeHead(response.status, [...response.headers].flat());
  if (response.body !== null) await stream(response.body, res, aborted.signal);
  else res.end();
}

/** Тело ответа в сокет; клиент ушёл — тело отменяется. */
async function stream(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  // Клиент ушёл — тело отменяется, как у сервера Deno: бесконечный
  // поток иначе читался бы вечно.
  const reader = body.getReader();
  signal.addEventListener(
    "abort",
    () => {
      // Отказ отмены дописывать некому: клиент уже ушёл.
      reader.cancel().catch((err) => console.error(err));
    },
    { once: true },
  );
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err) {
    // Тело оборвалось у обработчика — соединение рвётся, как у
    // сервера Deno: клиент видит обрыв, а не тихо укороченный ответ.
    console.error(err);
    res.destroy();
    return;
  }
  res.end();
}

async function requestOf(
  scheme: string,
  req: IncomingMessage,
  signal: AbortSignal,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const one of [value ?? []].flat()) headers.append(name, one);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const method = req.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : new Uint8Array(Buffer.concat(chunks));
  // Запрос к прокси несёт адрес целиком (`GET http://…`), прочие — путь.
  const url = new URL(req.url ?? "/", `${scheme}://${req.headers.host}`);
  return new Request(url, {
    method,
    headers,
    body,
    signal,
  });
}
