/**
 * Строка по WebSocket (`platform/back-rpc.md`, «Строка»): кадры — в
 * сокет, вопрос — кадром `ask` в тот же сокет, ответ — кадром `answer`,
 * ввод — по запросу кадром `stdinRequest`, ответ — кадром `stdin`
 * (`platform/stdin-on-request.md`), закрытие клиентом — строка закрыта.
 */

import {
  answerOf,
  askFrame,
  BadFrame,
  boundedInput,
  inputOnRequest,
  type InputSource,
  type LineInput,
  STDIN_REQUEST,
  stdinOf,
} from "../frames/mod.ts";
import { type Asking, type Delivery, Line } from "./line.ts";

/** Код закрытия сокета после кадра `exit`. */
const NORMAL_CLOSURE = 1000;

function socketDelivery(socket: WebSocket): Delivery {
  return {
    frame(frame) {
      // Сокет мог закрыться со стороны клиента раньше, чем пришло событие.
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(frame));
    },
    // Давление сокетом не передаётся: события «буфер отправки
    // опустел» у WebSocket нет, а опрос поля буфера — синхронизация по
    // таймеру (отклонение в `platform/line-cancel.md`).
    ready: () => Promise.resolve(),
    end: () => socket.close(NORMAL_CLOSURE),
  };
}

/** Вопрос — кадром `ask` в тот же сокет; отзывать нечего. */
const SOCKET_ASKING: Asking = {
  pose(line, question, kind) {
    line.deliver(askFrame(question, kind));
    return { revoke() {} };
  },
};

/** Ввод по запросу не пришёл: клиент ушёл раньше. */
export class InputLost extends Error {
  override name = "InputLost";
}

/** Что ввод по запросу делает в своём состоянии. */
interface Requesting {
  bytes(input: RequestedInput): Promise<Uint8Array>;
  arrived(input: RequestedInput, text: string): void;
  lost(input: RequestedInput): void;
}

/** Клиент ушёл: ввода не будет, чтение отвергается. */
function lostInput(input: RequestedInput) {
  input.fail(new InputLost("клиент ушёл до ввода"));
}

/**
 * Запроса ещё не было: ввод без него игнорируется. Клиент ушёл раньше
 * первого чтения — позднее чтение отвергается сразу, а не ждёт кадра,
 * которого не будет.
 */
const NOT_REQUESTED: Requesting = {
  bytes: (input) => input.request(),
  arrived() {},
  lost: lostInput,
};

/** Ввод получен или его уже не будет: дальше — только прежний итог. */
const SETTLED: Requesting = {
  bytes: (input) => input.result(),
  arrived() {},
  lost() {},
};

/** Запрос ушёл, ждём кадр `stdin`. */
const WAITING: Requesting = {
  bytes: (input) => input.result(),
  arrived: (input, text) => input.settle(text),
  lost: lostInput,
};

/**
 * Ввод, который клиент отдаёт по запросу строки: запрос уходит один раз
 * — при первом чтении, второе чтение берёт то же содержимое. Кадр
 * `stdin` без запроса или второй — игнорируется.
 */
class RequestedInput implements LineInput {
  readonly #line: Line;
  readonly #arrived = Promise.withResolvers<Uint8Array>();
  #state: Requesting = NOT_REQUESTED;

  constructor(line: Line) {
    this.#line = line;
    // Никто может не дождаться итога (строка кончилась раньше): отказ
    // без читателя не должен стать необработанным.
    this.#arrived.promise.catch(() => {});
  }

  bytes(): Promise<Uint8Array> {
    return this.#state.bytes(this);
  }

  /** Кадр `stdin` пришёл. */
  arrived(text: string) {
    this.#state.arrived(this, text);
  }

  /** Сокет закрыт. */
  lost() {
    this.#state.lost(this);
  }

  /** Первое чтение: кадр запроса клиенту. */
  request(): Promise<Uint8Array> {
    this.#state = WAITING;
    this.#line.deliver(STDIN_REQUEST);
    return this.result();
  }

  /** Ввод: копия на каждое чтение — буфер общий. */
  async result(): Promise<Uint8Array> {
    return (await this.#arrived.promise).slice();
  }

  /**
   * Ввод пришёл. Сверх предела — прежний отказ сервера: строка кончается
   * кодом 2, команду просят остановиться.
   */
  settle(text: string) {
    let bytes: Uint8Array;
    try {
      bytes = boundedInput(text);
    } catch (err) {
      if (!(err instanceof BadFrame)) throw err;
      this.fail(err);
      this.#line.stderr(`mpu-back: ${err.report}\n`);
      this.#line.asked();
      this.#line.finish(2);
      return;
    }
    this.#state = SETTLED;
    this.#arrived.resolve(bytes);
  }

  /** Ввода не будет: чтение отвергается. */
  fail(err: Error) {
    this.#state = SETTLED;
    this.#arrived.reject(err);
  }
}

/** Строка по сокету, её первый кадр и источник ввода. */
export interface SocketLine {
  readonly line: Line;
  /** Данные первого кадра; сокет закрыли раньше — `undefined`. */
  readonly first: Promise<unknown>;
  /** Ввод из кадра или по запросу у клиента этого сокета. */
  readonly input: InputSource;
}

/**
 * Строка поверх принятого сервером сокета.
 *
 * @param socket сокет строки
 */
export function socketLine(socket: WebSocket): SocketLine {
  const first = Promise.withResolvers<unknown>();
  const gone = Promise.withResolvers<void>();
  const line = new Line(socketDelivery(socket), SOCKET_ASKING, gone.promise);
  const requested = new RequestedInput(line);
  // Первый кадр — запрос строки, следующие — ответы на вопрос и ввод.
  let receive = (data: unknown) => {
    receive = (next) => {
      const text = answerOf(next);
      if (text !== undefined) line.answered(text);
      const input = stdinOf(next);
      if (input !== undefined) requested.arrived(input);
    };
    first.resolve(data);
  };
  socket.onmessage = (event) => receive(event.data);
  socket.onclose = () => {
    requested.lost();
    line.lost();
    first.resolve(undefined);
    gone.resolve();
  };
  return { line, first: first.promise, input: inputOnRequest(requested) };
}
