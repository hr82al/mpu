/**
 * Клиент WebSocket ровно под стрим `docker exec` через Portainer
 * (`platform/exec-transport.md`, п. 5): рукопожатие поверх HTTP/1.1 со
 * своими заголовками, приём данных, pong на ping сервера, свой ping в
 * простое и завершение по Close или EOF.
 *
 * Встроенный `WebSocket` здесь не годится дважды: он не даёт добавить
 * `X-API-Key` в рукопожатие и не умеет отправлять ping. Сокет берётся
 * через `node:net`/`node:tls` — у Deno нет способа отключить проверку
 * сертификата (`PORTAINER_VERIFY_TLS`), а у `node:tls` он есть; тем же
 * путём ходит и HTTP-клиент (`../http/mod.ts`).
 */

import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { DomainError } from "../command/mod.ts";
import { decodeFrame, encodeFrame, OPCODE, randomMask } from "./frames.ts";

/** Пауза простоя, после которой клиент шлёт ping (спека). */
const PING_INTERVAL_MS = 30_000;

/** Байтовый канал до сервера: сокет глазами клиента. */
export interface ByteChannel {
  readonly chunks: AsyncIterable<Uint8Array<ArrayBufferLike>>;
  readonly write: (bytes: Uint8Array) => void;
  readonly close: () => void;
}

/** Открыватель канала; подменяется в тестах транспорта. */
export type OpenChannel = (
  url: URL,
  insecure: boolean,
) => Promise<ByteChannel>;

/** Один прогон стрима. */
export interface WsStream {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly insecure: boolean;
  /** Данные сервера по мере поступления; порядок сохраняется. */
  readonly onData: (chunk: Uint8Array) => void;
  /** Прерывание вызова: канал закрывается, стрим завершается. */
  readonly signal?: AbortSignal;
  readonly pingIntervalMs?: number;
  readonly open?: OpenChannel;
}

/**
 * Отрабатывает до Close сервера, EOF или отмены. Отказ рукопожатия —
 * доменная ошибка (exit 1 по спеке: это сбой транспорта, а не ввода).
 */
export async function streamWebSocket(stream: WsStream): Promise<void> {
  // Функцией, а не выражением: между двумя проверками лежит ожидание
  // подключения, и компилятор иначе считает второе значение известным.
  const aborted = () => stream.signal?.aborted === true;
  if (aborted()) return;
  const open = stream.open ?? openSocket;
  const channel = await open(stream.url, stream.insecure);
  // Отмена, случившаяся за время подключения, слушателем уже не
  // поймается: он вешается ниже, а `abort` не повторяется.
  if (aborted()) {
    channel.close();
    return;
  }
  // Разрыв, сделанный нами, отличается от чужого: узел сообщает о нём
  // ошибкой потока («premature close»), а для вызывающего это штатное
  // завершение по отмене.
  let stopped = false;
  const stop = () => {
    stopped = true;
    channel.close();
  };
  stream.signal?.addEventListener("abort", stop, { once: true });
  // Признак поднят заранее: иначе первый ping ушёл бы не через паузу
  // простоя, а через две (спека — «в idle каждые 30 с»).
  let idle = true;
  const ping = setInterval(() => {
    // Пингуется именно простой: под данными соединение живо и без него.
    if (idle) send(channel, OPCODE.ping, new Uint8Array());
    idle = true;
  }, stream.pingIntervalMs ?? PING_INTERVAL_MS);
  // Итератор берётся один на рукопожатие и на стрим: выход из
  // `for await` закрыл бы поток вместе с сокетом, а он нужен дальше.
  const reader = channel.chunks[Symbol.asyncIterator]();
  try {
    let buffer = await handshake(channel, reader, stream.url, stream.headers);
    for (;;) {
      const done = drain(channel, buffer, stream.onData);
      buffer = done.rest;
      if (done.closed) break;
      const next = await reader.next();
      if (next.done === true) break;
      idle = false;
      buffer = concat(buffer, next.value);
    }
  } catch (err) {
    if (!stopped) throw err;
  } finally {
    clearInterval(ping);
    stream.signal?.removeEventListener("abort", stop);
    channel.close();
  }
}

/** Разбор всех целых кадров буфера; остаток копится до следующего куска. */
function drain(
  channel: ByteChannel,
  buffer: Uint8Array,
  onData: (chunk: Uint8Array) => void,
): { readonly rest: Uint8Array; readonly closed: boolean } {
  let rest = buffer;
  for (;;) {
    const cut = decodeFrame(rest);
    if (cut === null) return { rest, closed: false };
    rest = cut.rest;
    const { opcode, payload } = cut.frame;
    if (opcode === OPCODE.close) return { rest, closed: true };
    if (opcode === OPCODE.ping) {
      send(channel, OPCODE.pong, payload);
      continue;
    }
    // Pong сервера ничего не значит для вызывающего: он лишь
    // подтверждает, что соединение живо, а это и так видно.
    if (opcode === OPCODE.pong) continue;
    if (payload.length > 0) onData(payload);
  }
}

function send(channel: ByteChannel, opcode: number, payload: Uint8Array): void {
  channel.write(encodeFrame(opcode, payload, randomMask()));
}

/**
 * Рукопожатие HTTP/1.1 Upgrade. Возвращает байты, пришедшие следом за
 * заголовками: сервер вправе прислать первый кадр тем же пакетом, и
 * потерять его нельзя.
 */
async function handshake(
  channel: ByteChannel,
  reader: AsyncIterator<Uint8Array<ArrayBufferLike>>,
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomKey()}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  channel.write(new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`));

  let buffer = new Uint8Array();
  for (;;) {
    const next = await reader.next();
    if (next.done === true) break;
    buffer = concat(buffer, next.value);
    const end = indexOfHeaderEnd(buffer);
    if (end < 0) continue;
    const status = new TextDecoder().decode(buffer.subarray(0, end)).split(
      "\r\n",
    )[0];
    if (status.split(" ")[1] !== "101") {
      throw new DomainError(`WebSocket отклонён: ${status}`);
    }
    return buffer.subarray(end + 4);
  }
  throw new DomainError("WebSocket закрылся до ответа на рукопожатие");
}

function indexOfHeaderEnd(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (
      buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 &&
      buffer[i + 3] === 10
    ) return i;
  }
  return -1;
}

/** Ключ рукопожатия: 16 случайных байт в base64 (RFC 6455). */
function randomKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...raw));
}

/**
 * Склейка накопленного с новым куском. Копия делается всегда: кусок
 * сокета приходит поверх разделяемого буфера, и вернуть его как есть —
 * значит отдать наверх память, которую драйвер вправе переиспользовать.
 */
function concat(
  left: Uint8Array,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

/** Опции соединения: TLS или чистый TCP, в форме `node:tls`/`node:net`. */
export type SocketOptions =
  | {
    readonly kind: "tls";
    readonly tls: {
      readonly host: string;
      readonly port: number;
      readonly rejectUnauthorized: boolean;
      /** SNI; у литерального адреса его нет вовсе (спека). */
      readonly servername?: string;
    };
  }
  | {
    readonly kind: "tcp";
    readonly tcp: { readonly host: string; readonly port: number };
  };

/**
 * Опции сокета для URL стрима (`platform/exec-transport.md`, п. 5).
 * Отдельная функция от самого соединения: правило SNI проверяется без
 * сети, а сеть в тестах не поднимается.
 *
 * SNI шлётся только для доменного имени. Литеральный адрес расширение
 * не допускает, и `node:tls` отвергает его на клиенте, до всякого
 * обмена с сервером («must not be an IP address») — а Portainer фермы
 * адресуется как раз по IP, то есть это обычный случай, а не крайний.
 */
export function socketOptions(url: URL, insecure: boolean): SocketOptions {
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
  if (!secure) return { kind: "tcp", tcp: { host: url.hostname, port } };
  return {
    kind: "tls",
    tls: {
      host: url.hostname,
      port,
      rejectUnauthorized: !insecure,
      // Хост v6-адреса `URL` отдаёт в скобках, и `isIP` их не знает.
      ...(isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0
        ? { servername: url.hostname }
        : {}),
    },
  };
}

/**
 * Настоящий сокет. TCP-keepalive включён (спека): без него молчащий
 * exec рвётся на промежуточном оборудовании незаметно для обеих сторон.
 */
function openSocket(url: URL, insecure: boolean): Promise<ByteChannel> {
  const options = socketOptions(url, insecure);
  const socket = options.kind === "tls"
    ? tlsConnect(options.tls)
    : netConnect(options.tcp);
  socket.setKeepAlive(true);
  return new Promise((resolve, reject) => {
    const fail = (err: Error) =>
      reject(new DomainError(err.message, { cause: err }));
    socket.once("error", fail);
    socket.once(options.kind === "tls" ? "secureConnect" : "connect", () => {
      socket.off("error", fail);
      resolve({
        chunks: socket as AsyncIterable<Uint8Array>,
        write: (bytes) => {
          socket.write(bytes);
        },
        close: () => socket.destroy(),
      });
    });
  });
}
