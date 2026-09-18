/**
 * Одна строка по WebSocket (`platform/back-rpc.md`, «Строка»): сокет,
 * вопрос и ожидание ответа, кадры вывода и итога. Закрытая строка кадров
 * не шлёт и не исполняется — это решает её состояние, а не вызывающий.
 */

import type { Output } from "../entrypoint/mod.ts";
import { answerOf, type ServerFrame } from "../frames/mod.ts";
import { NO_SLOT, type Serial, type Slot } from "./queue.ts";

/** Сколько ждать ответа на вопрос: дальше ответ «нет». */
export const ANSWER_TIMEOUT_MS = 120_000;

/** Код закрытия сокета после кадра `exit`. */
const NORMAL_CLOSURE = 1000;

/** Код строки, не исполненной потому, что её уже закрыли. */
const NOT_RUN = 1;

/** Текст кадра `err` у строк, открытых при остановке сервера. */
const STOPPED = "mpu-back: остановлен\n";

/** Ожидание ответа на заданный вопрос. */
interface Waiting {
  settle(answer: string | undefined): void;
}

/** Вопроса нет: ответ, пришедший без него, игнорируется. */
const NOT_ASKED: Waiting = { settle() {} };

/** Строка открыта или закрыта: что делают отправка, вопрос, исполнение. */
interface State {
  send(socket: WebSocket, frame: ServerFrame): void;
  wait(line: SocketLine): Promise<string | undefined>;
  execute(
    line: SocketLine,
    slot: Slot,
    cwd: string,
    run: () => Promise<number>,
  ): Promise<number>;
  /** Закрыть сокет со своей стороны. */
  close(socket: WebSocket): void;
}

const OPEN: State = {
  send(socket, frame) {
    // Сокет мог закрыться со стороны клиента раньше, чем пришло событие.
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  },
  wait: (line) => line.armed(),
  execute(line, slot, cwd, run) {
    line.hold(slot);
    // Исполнение одно на процесс (очередь), поэтому каталог процесса —
    // каталог этой строки на всё её исполнение.
    Deno.chdir(cwd);
    return run();
  },
  close: (socket) => socket.close(NORMAL_CLOSURE),
};

const CLOSED: State = {
  send() {},
  wait: () => Promise.resolve(undefined),
  execute(_line, slot) {
    slot.leave();
    return Promise.resolve(NOT_RUN);
  },
  close() {},
};

/** Строка по сокету: её кадры, вопрос и итог. */
export class SocketLine implements Output {
  readonly #socket: WebSocket;
  readonly #first = Promise.withResolvers<unknown>();
  readonly #gone = Promise.withResolvers<void>();
  #state: State = OPEN;
  #waiting: Waiting = NOT_ASKED;
  #slot: Slot = NO_SLOT;
  /** Первый кадр — запрос строки, следующие — ответы на вопрос. */
  #receive: (data: unknown) => void = (data) => {
    this.#receive = (next) => this.#answered(next);
    this.#first.resolve(data);
  };

  /** @param socket сокет строки, уже принятый сервером */
  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onclose = () => {
      this.#closed();
      this.#gone.resolve();
    };
  }

  /** Сокет закрыт с обеих сторон. */
  gone(): Promise<void> {
    return this.#gone.promise;
  }

  /** Данные первого кадра; сокет закрыли раньше — `undefined`. */
  first(): Promise<unknown> {
    return this.#first.promise;
  }

  stdout(text: string) {
    this.#send({ out: text });
  }

  stderr(text: string) {
    this.#send({ err: text });
  }

  /** Вопрос клиенту кадром `ask`. */
  question(text: string) {
    this.#send({ ask: text });
  }

  /** Ответ на заданный вопрос; тишина или закрытие — `undefined`. */
  answer(): Promise<string | undefined> {
    return this.#state.wait(this);
  }

  /**
   * Исполнение строки в очереди, если к своей очереди она ещё открыта.
   * Место держится до кадра `exit`.
   */
  async execute(
    cwd: string,
    run: () => Promise<number>,
    serial: Serial,
  ): Promise<number> {
    const slot = await serial.enter();
    return await this.#state.execute(this, slot, cwd, run);
  }

  /** Место в очереди, которое строка отпустит своим кадром `exit`. */
  hold(slot: Slot) {
    this.#slot = slot;
  }

  /** Итог: кадр `exit`, закрытие сокета, место в очереди — следующему. */
  finish(code: number) {
    this.#send({ exit: code });
    this.#close();
    this.#slot.leave();
  }

  /** Остановка сервера: открытая строка получает отказ и итог. */
  stop() {
    this.stderr(STOPPED);
    this.finish(1);
  }

  /** Ожидание ответа открытой строки: до ответа, закрытия или таймаута. */
  armed(): Promise<string | undefined> {
    const answer = Promise.withResolvers<string | undefined>();
    const timer = setTimeout(
      () => this.#waiting.settle(undefined),
      ANSWER_TIMEOUT_MS,
    );
    this.#waiting = {
      settle: (text) => {
        clearTimeout(timer);
        this.#waiting = NOT_ASKED;
        answer.resolve(text);
      },
    };
    return answer.promise;
  }

  #send(frame: ServerFrame) {
    this.#state.send(this.#socket, frame);
  }

  /** Кадр после первого: ответ на вопрос, прочее — игнорируется. */
  #answered(data: unknown) {
    const text = answerOf(data);
    if (text !== undefined) this.#waiting.settle(text);
  }

  /** Закрытие со стороны сервера. */
  #close() {
    const state = this.#state;
    this.#closed();
    state.close(this.#socket);
  }

  /** Строка закрыта: ожидания отпускаются с ответом «нет». */
  #closed() {
    this.#state = CLOSED;
    this.#waiting.settle(undefined);
    this.#first.resolve(undefined);
  }
}
