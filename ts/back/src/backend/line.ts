/**
 * Одна строка сервера (`platform/back-rpc.md`, «Строка»): кадры вывода и
 * итога, вопрос и ожидание ответа, место в очереди. Куда уходят кадры и
 * как задаётся вопрос — дело транспорта (доставка и способ спросить);
 * закрытая строка кадров не шлёт и не исполняется — это решает её
 * состояние, а не вызывающий.
 */

import type { Output } from "../entrypoint/mod.ts";
import type { ServerFrame } from "../frames/mod.ts";
import { NO_SLOT, type Serial, type Slot } from "./queue.ts";

/** Сколько ждать ответа на вопрос: дальше ответ «нет». */
export const ANSWER_TIMEOUT_MS = 120_000;

/** Код строки, не исполненной потому, что её уже закрыли. */
const NOT_RUN = 1;

/** Текст кадра `err` у строк, открытых при остановке сервера. */
const STOPPED = "mpu-back: остановлен\n";

/** Куда уходят кадры строки. */
export interface Delivery {
  frame(frame: ServerFrame): void;
  /** Кадров больше не будет: закрыть поток. */
  end(): void;
}

/** Доставки нет: строка ждёт ответа по номеру, её ответ уже закончен. */
export const DETACHED: Delivery = { frame() {}, end() {} };

/** Что отменить, когда ожидание ответа кончилось. */
export interface Revocable {
  revoke(): void;
}

const NOTHING: Revocable = { revoke() {} };

/** Как строка задаёт вопрос: кадром в тот же поток или номером. */
export interface Asking {
  pose(line: Line, question: string): Revocable;
}

/** Ожидание ответа на заданный вопрос. */
interface Waiting {
  settle(answer: string | undefined): void;
}

/** Вопроса нет: ответ, пришедший без него, игнорируется. */
const NOT_ASKED: Waiting = { settle() {} };

/** Строка открыта или закрыта: что делают доставка, вопрос, исполнение. */
interface State {
  deliver(delivery: Delivery, frame: ServerFrame): void;
  wait(line: Line, posed: Revocable): Promise<string | undefined>;
  execute(
    line: Line,
    slot: Slot,
    cwd: string,
    run: () => Promise<number>,
  ): Promise<number>;
}

const OPEN: State = {
  deliver: (delivery, frame) => delivery.frame(frame),
  wait: (line, posed) => line.armed(posed),
  execute(line, slot, cwd, run) {
    line.hold(slot);
    // Исполнение одно на процесс (очередь), поэтому каталог процесса —
    // каталог этой строки на всё её исполнение.
    Deno.chdir(cwd);
    return run();
  },
};

const CLOSED: State = {
  deliver() {},
  wait(_line, posed) {
    posed.revoke();
    return Promise.resolve(undefined);
  },
  execute(_line, slot) {
    slot.leave();
    return Promise.resolve(NOT_RUN);
  },
};

/** Строка: её кадры, вопрос и итог. */
export class Line implements Output {
  readonly #asking: Asking;
  readonly #gone: Promise<void>;
  #delivery: Delivery;
  #state: State = OPEN;
  #waiting: Waiting = NOT_ASKED;
  #posed: Revocable = NOTHING;
  #slot: Slot = NO_SLOT;

  /**
   * @param delivery куда кадры идут сначала
   * @param asking как задаётся вопрос
   * @param gone когда транспорт строки закрыт с обеих сторон
   */
  constructor(delivery: Delivery, asking: Asking, gone: Promise<void>) {
    this.#delivery = delivery;
    this.#asking = asking;
    this.#gone = gone;
  }

  /** Транспорт строки закрыт с обеих сторон. */
  gone(): Promise<void> {
    return this.#gone;
  }

  stdout(text: string) {
    this.deliver({ out: text });
  }

  stderr(text: string) {
    this.deliver({ err: text });
  }

  /** Кадр текущей доставке, если строка открыта. */
  deliver(frame: ServerFrame) {
    this.#state.deliver(this.#delivery, frame);
  }

  /** Вопрос способом транспорта. */
  question(text: string) {
    this.#posed = this.#asking.pose(this, text);
  }

  /** Ответ на заданный вопрос; тишина, закрытие, остановка — `undefined`. */
  answer(): Promise<string | undefined> {
    const posed = this.#posed;
    this.#posed = NOTHING;
    return this.#state.wait(this, posed);
  }

  /** Ответ пришёл. */
  answered(text: string) {
    this.#waiting.settle(text);
  }

  /** Кадры дальше — в эту доставку. */
  attach(delivery: Delivery) {
    this.#delivery = delivery;
  }

  /** Ответ пришёл с новой доставкой: кадры после вопроса — в неё. */
  resume(delivery: Delivery, text: string) {
    this.attach(delivery);
    this.answered(text);
  }

  /** Ответ строки кончился, строка ждёт дальше без доставки. */
  detach() {
    const delivery = this.#delivery;
    this.#delivery = DETACHED;
    delivery.end();
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

  /** Итог: кадр `exit`, конец доставки, место в очереди — следующему. */
  finish(code: number) {
    this.deliver({ exit: code });
    const delivery = this.#delivery;
    this.lost();
    delivery.end();
    this.#slot.leave();
  }

  /** Остановка сервера: открытая строка получает отказ и итог. */
  stop() {
    this.stderr(STOPPED);
    this.finish(1);
  }

  /** Клиент ушёл: кадров больше не слать, ожидание — «нет». */
  lost() {
    this.#state = CLOSED;
    this.#delivery = DETACHED;
    this.#waiting.settle(undefined);
  }

  /** Ожидание ответа открытой строки: до ответа, закрытия или срока. */
  armed(posed: Revocable): Promise<string | undefined> {
    const answer = Promise.withResolvers<string | undefined>();
    const timer = setTimeout(
      () => this.#waiting.settle(undefined),
      ANSWER_TIMEOUT_MS,
    );
    this.#waiting = {
      settle: (text) => {
        clearTimeout(timer);
        posed.revoke();
        this.#waiting = NOT_ASKED;
        answer.resolve(text);
      },
    };
    return answer.promise;
  }
}
