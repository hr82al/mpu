/**
 * Предел одновременности строк (`platform/line-concurrency.md`):
 * сколько их исполняется разом. Место занимает сама строка и сама
 * отпускает его своим кадром `exit` — очереди «по одной» больше нет,
 * её роль играет предел, и «одна за раз» — это просто предел, равный
 * единице.
 */

/** Место в пределе: занято до `leave`. */
export interface Slot {
  leave(): void;
}

/** Места нет: отпускать нечего. */
export const NO_SLOT: Slot = { leave() {} };

/** Сколько строк идёт разом, если не сказано иное. */
export const DEFAULT_LINES = 16;

/** Предел одновременности строк сервера. */
export class Lines {
  #free: number;
  readonly #waiting: ((slot: Slot) => void)[] = [];

  /** @param limit сколько строк исполняется одновременно; больше нуля */
  constructor(limit: number) {
    this.#free = limit;
  }

  /** Место: свободное — сразу, иначе — когда его отпустит сосед. */
  enter(): Promise<Slot> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#taken());
    }
    const turn = Promise.withResolvers<Slot>();
    this.#waiting.push(turn.resolve);
    return turn.promise;
  }

  /**
   * Занятое место: отпускается один раз и дальше отвечает как «места
   * нет». Повторный `leave` одной и той же строки иначе освободил бы
   * чужое место — а строка зовёт его и своим кадром `exit`, и при
   * закрытии.
   */
  #taken(): Slot {
    let slot: Slot = {
      leave: () => {
        slot = NO_SLOT;
        this.#release();
      },
    };
    return { leave: () => slot.leave() };
  }

  /** Место освободилось: его берёт первый из ждущих, иначе — в запас. */
  #release() {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#free++;
      return;
    }
    next(this.#taken());
  }
}
