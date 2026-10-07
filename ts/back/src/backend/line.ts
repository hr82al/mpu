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

/**
 * Заданный вопрос глазами строки: отзыв, когда ждать перестали, и снятие
 * канала, когда решено в другом месте (`platform/ask-telegram.md` [D.1]).
 */
export interface Posed extends Revocable {
  /**
   * Решено в другом месте: канал вопроса снимается своим способом, строка
   * получает `answer`, как только канал может принять её продолжение.
   *
   * @param said что сказать каналу: `решено в Telegram — да`
   */
  settle(line: Line, answer: string, said: string): void;
  /**
   * Второй адресат, которого этот канал умеет снять
   * (`platform/ask-telegram.md` [D.1]): канал, которому о решении в
   * другом месте сказать нечем, второго адресата не получает.
   */
  admits(rival: Rival): Rival;
}

/** Как строка задаёт вопрос: кадром в тот же поток или номером. */
export interface Asking {
  pose(line: Line, question: string, kind: AskKind): Posed;
}

/**
 * Второй адресат вопроса строки — владелец в чате
 * (`platform/ask-telegram.md`): спрашивается, когда ожидание ответа уже
 * взведено, — ответ раньше ожидания по устройству невозможен.
 */
export interface Rival {
  /** Спросить; ответ второго — `decide`. */
  start(decide: (answer: string, said: string) => void): Rivalry;
}

/** Идущий вопрос второго адресата. */
export interface Rivalry {
  /**
   * Строка получила ответ из своего канала — в том числе решённый вторым
   * адресатом: вопрос, у которого исход уже есть, это не меняет.
   */
  answered(): void;
  /** Ответа не будет: срок, закрытие строки. */
  lapsed(): void;
  /** Вопрос второго закрыт: исход и правка сообщения позади. */
  closed(): Promise<void>;
}

const CLOSED_RIVALRY: Promise<void> = Promise.resolve();

const NO_RIVALRY: Rivalry = {
  answered() {},
  lapsed() {},
  closed: () => CLOSED_RIVALRY,
};

/** Второго адресата нет: секрет, не подтверждение, строка без человека. */
export const NO_RIVAL: Rival = { start: () => NO_RIVALRY };

const NOTHING: Posed = {
  revoke() {},
  settle() {},
  admits: () => NO_RIVAL,
};

/** Заданный вопрос: как его задали и кто второй адресат. */
interface Question {
  readonly posed: Posed;
  readonly rival: Rival;
}

/** Вопроса нет. */
const NOT_POSED: Question = { posed: NOTHING, rival: NO_RIVAL };

/** Ожидание ответа на заданный вопрос: первое сообщение решает. */
interface Waiting {
  /** Ответ канала строки. */
  answered(text: string): void;
  /** Ответа не будет: срок или строка закрыта. */
  lapse(): void;
  /** Ответил второй адресат. */
  elsewhere(answer: string, said: string): void;
}

/** Вопроса нет: ответ, пришедший без него, игнорируется. */
const NOT_ASKED: Waiting = { answered() {}, lapse() {}, elsewhere() {} };

/**
 * Что со строкой: ещё не исполняется, исполняется или закрыта. От этого
 * зависят доставка, ожидание ответа, исполнение и то, что значит уход
 * клиента.
 */
interface State {
  deliver(delivery: Delivery, frame: ServerFrame): void;
  ready(delivery: Delivery): Promise<void>;
  wait(line: Line, question: Question): Promise<string | undefined>;
  execute(line: Line, slot: Slot, run: () => Promise<number>): Promise<number>;
  /** Клиент перестал слушать. */
  lost(line: Line): void;
}

/** Строка живёт: кадры идут клиенту, уход клиента — просьба остановиться. */
const OPEN: State = {
  deliver: (delivery, frame) => delivery.frame(frame),
  ready: (delivery) => delivery.ready(),
  wait: (line, question) => line.armed(question),
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
  wait(_line, { posed }) {
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
  #question: Question = NOT_POSED;
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
   * @param rival второй адресат того же вопроса
   */
  question(text: string, kind: AskKind = "line", rival: Rival = NO_RIVAL) {
    const posed = this.#asking.pose(this, text, kind);
    this.#question = { posed, rival: posed.admits(rival) };
  }

  /** Ответ на заданный вопрос; тишина, закрытие, остановка — `undefined`. */
  answer(): Promise<string | undefined> {
    const question = this.#question;
    this.#question = NOT_POSED;
    return this.#state.wait(this, question);
  }

  /** Ответ канала строки пришёл. */
  answered(text: string) {
    this.#waiting.answered(text);
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
  async execute(run: () => Promise<number>, lines: Lines): Promise<number> {
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
    this.#waiting.lapse();
  }

  /**
   * Остановиться просили: команда узнаёт об этом своим сигналом. Строку,
   * которая ещё не начинала исполняться, просьба не меняет — код ей
   * ставит не она, а её собственный исход (`execute`).
   */
  asked() {
    this.#stopping.ask();
  }

  /**
   * Ожидание ответа открытой строки: до ответа канала, ответа второго
   * адресата, закрытия или срока — что раньше. Ответ отдаётся, когда у
   * вопроса второго адресата есть исход: его промис не остаётся висеть за
   * строкой.
   */
  async armed({ posed, rival }: Question): Promise<string | undefined> {
    const answer = Promise.withResolvers<string | undefined>();
    const timer = setTimeout(() => this.#waiting.lapse(), ANSWER_TIMEOUT_MS);
    const end = (text: string | undefined) => {
      clearTimeout(timer);
      posed.revoke();
      this.#waiting = NOT_ASKED;
      answer.resolve(text);
    };
    let rivalry = NO_RIVALRY;
    this.#waiting = {
      answered: (text) => {
        end(text);
        rivalry.answered();
      },
      lapse: () => {
        end(undefined);
        rivalry.lapsed();
      },
      elsewhere: (text, said) => posed.settle(this, text, said),
    };
    rivalry = rival.start((text, said) => this.#waiting.elsewhere(text, said));
    // Обработчики обоих — сразу: отказ вопроса второго адресата, пришедший
    // раньше ответа, иначе остался бы необработанным.
    const [text] = await Promise.all([answer.promise, rivalry.closed()]);
    return text;
  }
}
