/**
 * Сервер на петле поверх `node:http` (`@hono/node-server`) с WebSocket
 * (`ws`): одинаково под Bun, Node и Deno (`platform/node-runtime.md`,
 * [S.5]). Запрос с `Upgrade` проходит тот же `fetch`, что и обычный, —
 * гейт пути один; решает обработчик, приняв запрос через `Upgrades`.
 */

import { once } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { LOOPBACK } from "@mpu/base/access";

/**
 * Сокет, принятый сервером, — то, чем пользуются строка и канал.
 * Текстовый кадр клиента приходит строкой, двоичный — байтами: такой
 * кадр не разбирается (`parsedJson` берёт только строку).
 */
export interface AcceptedSocket {
  /** Открыт ли: в закрытый слать нечего. */
  isOpen(): boolean;
  send(text: string): void;
  /**
   * Всё отправленное до сих пор отдано ОС: медленный клиент держит
   * обещание, пока не разберёт своё (`platform/line-cancel.md`).
   */
  drained(): Promise<void>;
  close(code?: number): void;
  onMessage(listener: (data: string | Uint8Array) => void): void;
  /**
   * Закрытие началось — кадром закрытия с любой стороны или обрывом
   * соединения; слушатель зовётся один раз. Клиент к этому моменту уже
   * ушёл: дальше строка ему не пишет.
   */
  onClosing(listener: () => void): void;
  /** Соединение закрыто с обеих сторон; слушатель зовётся один раз. */
  onClose(listener: () => void): void;
}

/** Часть поверхности сокета `ws`, которой пользуется модуль. */
interface WsSocket {
  readonly readyState: number;
  send(data: string, sent?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(
    event: "message",
    listener: (data: Uint8Array, isBinary: boolean) => void,
  ): void;
  once(event: "close", listener: () => void): void;
}

/** Часть поверхности сервера `ws`, которой пользуется модуль. */
interface WsServer {
  readonly clients: ReadonlySet<WsSocket>;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Uint8Array,
    accepted: (socket: WsSocket) => void,
  ): void;
}

/** Конструктор сервера `ws` в режиме без своего порта. */
type WsServerClass = new (options: {
  readonly noServer: true;
  readonly handleProtocols: (
    offered: ReadonlySet<string>,
    request: IncomingMessage,
  ) => string | false;
}) => WsServer;

// Своих типов `ws` не несёт (`ts/CLAUDE.md`, «Зависимости»): поверхность
// объявлена выше, как у `pg` в `src/sql/pg.ts`.
const WsServerOf = WebSocketServer as WsServerClass;

/** `readyState` открытого сокета (одинаков у `ws` и веб-API). */
const OPEN = 1;

const decoder = new TextDecoder();

/**
 * Сокет `ws` глазами строки. `raw` — сокет соединения под ним: по нему
 * видно начало закрытия (см. `onClosing`).
 */
function acceptedOf(socket: WsSocket, raw: Duplex): AcceptedSocket {
  let drained = Promise.resolve();
  return {
    isOpen: () => socket.readyState === OPEN,
    send: (text) => {
      const sent = Promise.withResolvers<void>();
      // Ошибка записи — обрыв соединения: о нём скажет `closing`, а
      // ждущий давления не должен висеть.
      socket.send(text, () => sent.resolve());
      drained = sent.promise;
    },
    drained: () => drained,
    close: (code) => socket.close(code),
    // По `isBinary`, а не по типу данных: под Bun `ws` подменён своей
    // реализацией, и текстовый кадр приходит там байтами.
    onMessage: (listener) =>
      socket.on("message", (data, isBinary) =>
        listener(isBinary ? data : decoder.decode(data)),
      ),
    // `close` у `ws` приходит только после слива буфера отправки и
    // закрытия TCP, а клиент видит своё закрытие уже по ответному кадру:
    // сервер узнавал бы об уходе клиента позже него самого, а под потоком
    // вывода — на секунды (замер 2026-10-07: 4,6 МБ в буфере, 1,7 с). Кадр
    // закрытия `ws` разбирает своим слушателем `data`, поставленным раньше
    // нашего, и тут же переводит сокет из `OPEN`: это видно сразу после
    // куска. Обрыв без кадра сообщает `close`.
    //
    // Под Bun ветка `data` молчит: `ws` подменён реализацией рантайма,
    // и она забирает сокет себе — событий `data` на нём нет вовсе. Зато
    // `close` там приходит по кадру закрытия, не дожидаясь слива буфера
    // (замер 2026-10-07, клиент не читает, 12,5 МБ в очереди: под Node
    // ранний сигнал +3 мс, `close` +232 мс; под Bun `close` +1 мс). Сервер
    // узнаёт об уходе клиента одинаково быстро под обоими.
    onClosing: (listener) => {
      let heard = false;
      const once = () => {
        if (heard) return;
        heard = true;
        raw.off("data", seen);
        listener();
      };
      const seen = () => {
        if (socket.readyState !== OPEN) once();
      };
      raw.on("data", seen);
      socket.once("close", once);
    },
    onClose: (listener) => socket.once("close", listener),
  };
}

/** Решение обработчика по запросу, пришедшему апгрейдом. */
interface Slot {
  accepted?: {
    readonly protocol: string | undefined;
    readonly use: (socket: AcceptedSocket) => void;
  };
}

/**
 * Апгрейды сервера: какой запрос пришёл апгрейдом и что с ним решил
 * обработчик. Принятые сокеты закрывает остановка сервера.
 */
export class Upgrades {
  readonly #slots = new WeakMap<Request, Slot>();
  readonly #protocols = new WeakMap<IncomingMessage, string>();
  readonly #server: WsServer = new WsServerOf({
    noServer: true,
    handleProtocols: (_offered, request) =>
      this.#protocols.get(request) ?? false,
  });

  /**
   * Принять запрос как WebSocket: сокет получит `use`.
   *
   * @param protocol подпротокол ответа; `undefined` — без него
   * @returns ответ обработчика; запрос пришёл не апгрейдом — `undefined`
   */
  accept(
    request: Request,
    protocol: string | undefined,
    use: (socket: AcceptedSocket) => void,
  ): Response | undefined {
    const slot = this.#slots.get(request);
    if (slot === undefined) return undefined;
    slot.accepted = { protocol, use };
    // Клиенту этот ответ не уходит: рукопожатие пишет `ws`. Статус 101
    // конструктор `Response` не принимает — заглушка любая из 2xx.
    return new Response(null, { status: 204 });
  }

  /** Запрос с `Upgrade`: через `fetch`, а затем рукопожатие или отказ. */
  async upgrade(
    fetch: (request: Request) => Response | Promise<Response>,
    incoming: IncomingMessage,
    socket: Duplex,
    head: Uint8Array,
  ): Promise<void> {
    // Обрыв клиентом посреди рукопожатия или после отказа: `node:http`
    // снял со своего сокета слушателей, `ws` ставит свой только в
    // `handleUpgrade`, а `error` без слушателя уронил бы сервер. Отвечать
    // ушедшему некому — сокет просто закрывается.
    const dropped = () => socket.destroy();
    socket.on("error", dropped);
    const request = requestOf(incoming);
    const slot: Slot = {};
    this.#slots.set(request, slot);
    const response = await fetch(request);
    const accepted = slot.accepted;
    if (accepted === undefined) {
      socket.end(await rawResponse(response));
      return;
    }
    if (accepted.protocol !== undefined) {
      this.#protocols.set(incoming, accepted.protocol);
    }
    // Дальше сокет слушает `ws`.
    socket.off("error", dropped);
    this.#server.handleUpgrade(incoming, socket, head, (ws) => {
      accepted.use(acceptedOf(ws, socket));
    });
  }

  /** Закрывает принятые сокеты без рукопожатия закрытия. */
  terminate() {
    for (const socket of this.#server.clients) socket.terminate();
  }
}

function requestOf(incoming: IncomingMessage): Request {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    headers.append(raw[i], raw[i + 1]);
  }
  const host = incoming.headers.host ?? LOOPBACK;
  return new Request(`http://${host}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers,
  });
}

/** Ответ HTTP/1.1 целиком: статус, заголовки, тело; соединение закрывается. */
async function rawResponse(response: Response): Promise<Uint8Array> {
  const body = new Uint8Array(await response.arrayBuffer());
  const lines = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`,
  ];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  lines.push(`Content-Length: ${body.byteLength}`, "Connection: close");
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  const whole = new Uint8Array(head.byteLength + body.byteLength);
  whole.set(head);
  whole.set(body, head.byteLength);
  return whole;
}

/** Слушающий сервер. */
export interface Listening {
  readonly port: number;
  readonly hostname: string;
  /** Закрывает соединения и сокет; ждёт закрытия. */
  stop(): Promise<void>;
}

/**
 * Поднимает сервер на петле.
 *
 * @param port порт; 0 — любой свободный
 * @param upgrades апгрейды: запросы с `Upgrade` и принятые сокеты
 * @throws Error с `code === "EADDRINUSE"` — порт занят
 */
export async function listenLoopback(options: {
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly upgrades: Upgrades;
}): Promise<Listening> {
  const { fetch, upgrades } = options;
  // `serve` отдаёт `http.Server`, пока не попросили HTTP/2.
  const server = serve({
    fetch,
    port: options.port,
    hostname: LOOPBACK,
    // Без этого `serve` подменяет глобальные `Request`/`Response` своими
    // на весь процесс: чужой код (и соседний сервер под Deno) получил бы
    // чужой класс ответа.
    overrideGlobalObjects: false,
    // Своя «уборка» непрочитанного тела запроса рушит сокет keep-alive
    // через два таймера после ответа — посреди следующего запроса на нём,
    // и клиент повторяет тот POST (замер 2026-10-07: одноразовый ключ
    // `web` гасился дважды). Непрочитанное тело сливает сам `node:http`.
    autoCleanupIncoming: false,
  }) as Server;
  // Отказ привязки (`EADDRINUSE`) — отказ `once`; слушатели снимаются.
  await once(server, "listening");
  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head) => {
    upgrades.upgrade(fetch, incoming, socket, head).catch(() => {
      // Ошибку обработчика Hono уже превратил в ответ 500; сюда доходит
      // запрос, из которого нельзя собрать `Request` (негодный `Host`,
      // заголовок), — отвечать по нему нечем, сокет закрывается.
      socket.destroy();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`адрес петли не порт: ${address}`);
  }
  return {
    port: address.port,
    hostname: LOOPBACK,
    stop: () => {
      upgrades.terminate();
      // Без закрытия соединений `close` ждёт keep-alive клиентов, и
      // процесс под Deno не выходит (проба этапа 2).
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((err) => {
          // Под Bun `closeAllConnections` гасит и сам сервер, и `close`
          // отвечает «не запущен» (проба 2026-10-07; Node и Deno — нет):
          // цель остановки уже достигнута.
          if (err === undefined || isNotRunning(err)) resolve();
          else reject(err);
        }),
      );
    },
  };
}

/** Отказ `close` у уже остановленного сервера. */
function isNotRunning(err: Error): boolean {
  return "code" in err && err.code === "ERR_SERVER_NOT_RUNNING";
}
