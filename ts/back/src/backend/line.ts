/**
 * Одна строка сервера (`platform/back-rpc.md`, «Строка»): кадры вывода и
 * итога, вопрос и ожидание ответа, место в очереди. Куда уходят кадры и
 * как задаётся вопрос — дело транспорта (доставка и способ спросить);
 * закрытая строка кадров не шлёт и не исполняется — это решает её
 * состояние, а не вызывающий.
 */

import type { Output } from "../entrypoint/mod.ts";
import type { AskKind, ServerFrame } from "../frames/mod.ts";
import { type Lines, NO_SLOT, type Slot } from "./limit.ts";
import { type Outlet, WHOLE } from "./outlet.ts";
import { Stopping } from "./stopping.ts";

/** Сколько ждать ответа на вопрос: дальше ответ «нет». */
export const ANSWER_TIMEOUT_MS = 120_000;

/** Код строки, не исполненной потому, что её уже закрыли. */
const NOT_RUN = 1;

/** Текст кадра `err` у строк, открытых при остановке сервера. */
const STOPPED = "mpu-back: остановлен\n";

/** Куда уходят кадры строки. */
export interface Delivery {
  frame(frame: ServerFrame): void;
  /**
   * Готовность принять следующий кадр: медленный клиент отвечает
   * обещанием, которое разрешится, когда он разберёт уже отданное
   * (`platform/line-cancel.md`). Доставке, у которой давления нет,
   * отвечать нечем — она готова всегда.
   */
  ready(): Promise<void>;
  /** Кадров больше не будет: закрыть поток. */
  end(): void;
}

/** Готова всегда: давление такой доставке передать нечем. */
const READY: Promise<void> = Promise.resolve();

/** Доставки нет: строка ждёт ответа по номеру, её ответ уже закончен. */
export const DETACHED: Delivery = {
  frame() {},
  ready: () => READY,
  end() {},
};

/** Что отменить, когда ожидание ответа кончилось. */
export interface Revocable {
  revoke(): void;
}

const NOTHING: Revocable = { revoke() {} };

/** Как строка задаёт вопрос: кадром в тот же поток или номером. */
export interface Asking {
  pose(line: Line, question: string, kind: AskKind): Revocable;
}

/** Ожидание ответа на заданный вопрос. */
interface Waiting {
  settle(answer: string | undefined): void;
}

/** Вопроса нет: ответ, пришедший без него, игнорируется. */
const NOT_ASKED: Waiting = { settle() {} };

/**
 * Что со строкой: ещё не исполняется, исполняется или закрыта. От этого
 * зависят доставка, ожидание ответа, исполнение и то, что значит уход
 * клиента.
 */
interface State {
  deliver(delivery: Delivery, frame: ServerFrame): void;
  ready(delivery: Delivery): Promise<void>;
  wait(line: Line, posed: Revocable): Promise<string | undefined>;
  execute(
    line: Line,
    slot: Slot,
    run: () => Promise<number>,
  ): Promise<number>;
  /** Клиент перестал слушать. */
  lost(line: Line): void;
}

/** Строка живёт: кадры идут клиенту, уход клиента — просьба остановиться. */
const OPEN: State = {
  deliver: (delivery, frame) => delivery.frame(frame),
  ready: (delivery) => delivery.ready(),
  wait: (line, posed) => line.armed(posed),
  execute(line, slot, run) {
    line.hold(slot);
    // Каталог процесса не трогаем: он у строки свой и доезжает до
    // команды портами (`platform/line-concurrency.md`), поэтому строки
    // и могут идти одновременно.
    return run();
  },
  lost(line) {
    line.shut();
    line.asked();
  },
};

const CLOSED: State = {
  deliver() {},
  ready: () => READY,
  wait(_line, posed) {
    posed.revoke();
    return Promise.resolve(undefined);
  },
  execute(_line, slot) {
    slot.leave();
    return Promise.resolve(NOT_RUN);
  },
  lost() {},
};

/** Строка: её кадры, вопрос и итог. */
export class Line implements Output {
  readonly #asking: Asking;
  readonly #gone: Promise<void>;
  readonly #stopping = new Stopping();
  #delivery: Delivery;
  #state: State = OPEN;
  #waiting: Waiting = NOT_ASKED;
  #posed: Revocable = NOTHING;
  #slot: Slot = NO_SLOT;
  /** Как собранный ответ отдаст вывод; до конца прогона — целиком. */
  #outlet: Outlet = WHOLE;

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

  /** Сигнал остановки: его видит команда портом `CommandIo`. */
  stopping(): AbortSignal {
    return this.#stopping.signal();
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

  /**
   * Готовность клиента принять следующий кадр. Закрытая строка готова
   * всегда: ждать её вывод некому.
   */
  ready(): Promise<void> {
    return this.#state.ready(this.#delivery);
  }

  /**
   * Вопрос способом транспорта.
   *
   * @param text текст вопроса как его увидит человек
   * @param kind вид ответа: видимый или скрытый
   */
  question(text: string, kind: AskKind = "line") {
    this.#posed = this.#asking.pose(this, text, kind);
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
   * Исполнение строки, когда в пределе одновременности нашлось место и
   * строка к этому времени ещё открыта. Место держится до кадра `exit`.
   */
  async execute(
    run: () => Promise<number>,
    lines: Lines,
  ): Promise<number> {
    const slot = await lines.enter();
    let code: number;
    try {
      code = await this.#state.execute(this, slot, run);
    } catch (err) {
      return this.#stopping.failed(err);
    }
    // Код спрашивается по факту остановки, а не по факту обрыва канала:
    // обрыв мог прийти уже после конца команды.
    return this.#stopping.outcome(code);
  }

  /** Место в пределе, которое строка отпустит своим кадром `exit`. */
  hold(slot: Slot) {
    this.#slot = slot;
  }

  /**
   * Прогон кончился: отдачу вывода выбрала дверь по его итогу
   * (`platform/long-output.md`, §4). Строка без прогона — остановленная
   * сервером или упавшая до него — отдаёт вывод целиком.
   */
  ran(outlet: Outlet) {
    this.#outlet = outlet;
  }

  /** Отдача вывода собранного ответа. */
  outlet(): Outlet {
    return this.#outlet;
  }

  /** Итог: кадр `exit`, конец доставки, место в пределе — следующему. */
  finish(code: number) {
    this.deliver({ exit: code });
    const delivery = this.#delivery;
    // Строка кончилась сама — это не уход клиента: просить её
    // остановиться уже незачем.
    this.shut();
    delivery.end();
    this.#slot.leave();
  }

  /** Остановка сервера: открытая строка получает отказ и итог. */
  stop() {
    this.stderr(STOPPED);
    this.finish(1);
  }

  /** Клиент ушёл: что это значит, решает состояние строки. */
  lost() {
    this.#state.lost(this);
  }

  /** Закрыться: кадров больше не слать, ожидание ответа — «нет». */
  shut() {
    this.#state = CLOSED;
    this.#delivery = DETACHED;
    this.#waiting.settle(undefined);
  }

  /**
   * Остановиться просили: команда узнаёт об этом своим сигналом. Строку,
   * которая ещё не начинала исполняться, просьба не меняет — код ей
   * ставит не она, а её собственный исход (`execute`).
   */
  asked() {
    this.#stopping.ask();
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
