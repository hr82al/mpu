/**
 * Строка по WebSocket (`platform/back-rpc.md`, «Строка»): кадры — в
 * сокет, вопрос — кадром `ask` в тот же сокет, ответ — кадром `answer`,
 * закрытие клиентом — строка закрыта.
 */

import { answerOf, askFrame } from "../frames/mod.ts";
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

/** Строка по сокету и её первый кадр. */
export interface SocketLine {
  readonly line: Line;
  /** Данные первого кадра; сокет закрыли раньше — `undefined`. */
  readonly first: Promise<unknown>;
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
  // Первый кадр — запрос строки, следующие — ответы на вопрос.
  let receive = (data: unknown) => {
    receive = (next) => {
      const text = answerOf(next);
      if (text !== undefined) line.answered(text);
    };
    first.resolve(data);
  };
  socket.onmessage = (event) => receive(event.data);
  socket.onclose = () => {
    line.lost();
    first.resolve(undefined);
    gone.resolve();
  };
  return { line, first: first.promise };
}
