/**
 * Подставной HTTP-сервер на петле для тестов `*.test.ts`: обработчик в
 * форме `Request → Response`, сервер — `node:http`, одинаковый под Bun, Node
 * и Deno; копия используемой части `back/src/testing/http.ts` mpu:
 * библиотека собирается и тестируется без `ts/`.
 *
 * Модуль подключают только тесты; в `dist/` он не попадает.
 */

import { Buffer } from "node:buffer";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Server as NetServer } from "node:net";

/** Обработчик запроса в форме `Request → Response`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Запущенный сервер. */
export interface FakeHttp {
  /** `http://127.0.0.1:<порт>`, без `/`. */
  readonly baseUrl: string;
  readonly port: number;
  /**
   * Перестать принимать соединения и дождаться начатых ответов. Висящий
   * обработчик тест отпускает до `stop`: при живом клиенте `stop` ждёт его
   * ответа без срока.
   */
  stop(): Promise<void>;
}

/** Поднимает сервер на `127.0.0.1` и свободном порту. */
export async function serveFetch(handler: FetchHandler): Promise<FakeHttp> {
  const server: Server = createServer((req, res) => {
    // Сбой записи ответа (клиент ушёл посреди `writeHead`/`write`) —
    // соединение рвётся, ошибка видна в выводе прогона.
    answer(handler, req, res).catch((err) => {
      console.error(err);
      res.destroy();
    });
  });
  const port = await listenLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        server.closeIdleConnections();
      }),
  };
}

/** Ставит `server` слушать свободный порт `127.0.0.1`; ответ — порт. */
export async function listenLoopback(server: NetServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`адрес петли не порт: ${address}`);
  }
  return address.port;
}

async function answer(
  handler: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Обрыв клиентом до конца ответа — отмена запроса (`request.signal`).
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort();
  });
  let response: Response;
  try {
    response = await handler(await requestOf(req, aborted.signal));
  } catch (err) {
    // Брошенное из обработчика — ответ 500, ошибка видна в выводе.
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
  aborted: AbortSignal,
): Promise<void> {
  // Бесконечный поток без отмены читался бы вечно.
  const reader = body.getReader();
  aborted.addEventListener(
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
    // Тело оборвалось у обработчика — соединение рвётся: клиент видит
    // обрыв, а не тихо укороченный ответ.
    console.error(err);
    res.destroy();
    return;
  }
  res.end();
}

async function requestOf(
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
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  return new Request(url, { method, headers, body, signal });
}
