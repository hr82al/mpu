/**
 * Машина программы (`platform/evaluator.md`, «Уступка и стек»): кадры
 * вызванных блоков — в куче, а не на стеке JS, поэтому глубина вызовов
 * ограничена памятью, а не стеком. После каждого запроса машина
 * проверяет отмену и по мере надобности отдаёт управление циклу событий —
 * так кадр `stop` доходит до бесконечного цикла.
 */

import { Refusal } from "../objects/mod.ts";
import { NIL } from "./objects.ts";
import type { Answer, Reply, Request, Stack, Value } from "./protocol.ts";

/** Когда машине отдать управление циклу событий. */
export interface Pace {
  /** Шаг сделан: промис, после которого машина продолжит. */
  step(): Promise<void>;
}

const GOING: Promise<void> = Promise.resolve();

/**
 * Уступка не реже раза в `ms` миллисекунд. Цикл событий обслуживает ввод
 * (кадр `stop`) только между макрозадачами: разрешённый промис —
 * микрозадача, и цикл, ждущий только их, отмены не услышит никогда. По
 * часам, а не по счёту шагов: макрозадача стоит около миллисекунды, и
 * уступка на каждом N-м шаге растягивала бы глубокую рекурсию в разы.
 */
export class Every implements Pace {
  readonly #ms: number;
  readonly #now: () => number;
  #last: number;

  /** @param now часы в миллисекундах */
  constructor(ms: number, now: () => number) {
    this.#ms = ms;
    this.#now = now;
    this.#last = now();
  }

  step(): Promise<void> {
    const now = this.#now();
    if (now - this.#last < this.#ms) return GOING;
    this.#last = now;
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Как часто уступать по умолчанию, мс: отмена доходит за доли секунды. */
export const DEFAULT_PACE_MS = 50;

/** Программу отменили: кадр `stop` или обрыв вызывающего. */
export class Cancelled extends Error {
  override name = "Cancelled";
}

/**
 * Отказ вычисления с местом: номер верхнего выражения и самый
 * внутренний блок, отказ объекта и промежуток слов сообщения.
 */
export class Placed extends Error {
  override name = "Placed";
  readonly place: string;
  readonly refusal: Refusal;
  readonly span: Span;

  constructor(place: string, refusal: Refusal, span: Span) {
    super(`${place}: ${refusal.message}`, { cause: refusal });
    this.place = place;
    this.refusal = refusal;
    this.span = span;
  }
}

/** Номер исполняемого верхнего выражения — его ведёт программа. */
export class Place {
  #statement = 0;

  /** Началось выражение `n` (с 1). */
  at(n: number) {
    this.#statement = n;
  }

  /** Место текстом: `выражение 2` и, если есть, `, блок each:`. */
  text(block: string): string {
    const head = `выражение ${this.#statement}`;
    return block === "" ? head : `${head}, ${block}`;
  }
}

/** Кадр: ответ, который идёт, и его место в тексте ошибки. */
interface Frame {
  readonly answer: Answer;
  /** `блок each:`; у кадра программы — пусто. */
  readonly label: string;
}

/** Что машине нужно снаружи. */
export interface MachinePorts {
  readonly signal: AbortSignal;
  readonly pace: Pace;
  print(text: string): void;
  core(words: readonly string[]): Promise<Reply>;
}

/** Машина одной программы. */
export class Machine implements Stack {
  readonly #ports: MachinePorts;
  readonly #place: Place;
  readonly #frames: Frame[] = [];
  #input: Value = NIL;

  constructor(ports: MachinePorts, place: Place) {
    this.#ports = ports;
    this.#place = place;
  }

  /**
   * Исполняет ответ программы до конца и отдаёт её итог.
   *
   * @throws Cancelled — отмена
   * @throws Placed — отказ вычисления с местом
   */
  async run(program: Answer): Promise<Value> {
    this.#frames.push({ answer: program, label: "" });
    for (;;) {
      const top = this.#frames[this.#frames.length - 1];
      const step = this.#stepped(top);
      if (step.done === true) {
        this.#frames.pop();
        this.#input = step.value;
        if (this.#frames.length === 0) return step.value;
        continue;
      }
      if (this.#ports.signal.aborted) throw new Cancelled("программа отменена");
      await this.#ports.pace.step();
      try {
        await step.value.enter(this);
      } catch (err) {
        throw this.#placed(err);
      }
    }
  }

  #stepped(frame: Frame): IteratorResult<Request, Value> {
    try {
      return frame.answer.next(this.#input);
    } catch (err) {
      throw this.#placed(err);
    }
  }

  /** Отказ получает место; прочее — как есть. */
  #placed(err: unknown): unknown {
    return placed(err, this.#place.text(this.#innermost()));
  }

  /** Метка самого внутреннего кадра блока; блоков нет — пусто. */
  #innermost(): string {
    return this.#frames.reduce(
      (label, frame) => frame.label === "" ? label : frame.label,
      "",
    );
  }

  push(answer: Answer, label: string) {
    this.#frames.push({ answer, label });
    this.#input = NIL;
  }

  resume(value: Value) {
    this.#input = value;
  }

  print(text: string) {
    this.#ports.print(text);
  }

  core(words: readonly string[]): Promise<Reply> {
    return this.#ports.core(words);
  }
}

/** Промежуток слов программы: начало и конец (не включительно). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Отказ объекта с промежутком слов сообщения, которому отказали. */
export class Misstep extends Error {
  override name = "Misstep";
  readonly refusal: Refusal;
  readonly span: Span;

  constructor(refusal: Refusal, span: Span) {
    super(refusal.message, { cause: refusal });
    this.refusal = refusal;
    this.span = span;
  }
}

/** Промежутка нет: подсказке заменять нечего. */
export const NO_SPAN: Span = { start: 0, end: 0 };

/** Отказ `err` у сообщения в словах `span`; прочее — как есть. */
export function misstep(err: unknown, span: Span): unknown {
  if (!(err instanceof Refusal)) return err;
  return new Misstep(err, span);
}

/**
 * Отказ `err` на месте `place`: с промежутком — его, без — без
 * подсказки; прочее — как есть.
 */
export function placed(err: unknown, place: string): unknown {
  if (err instanceof Misstep) return new Placed(place, err.refusal, err.span);
  if (err instanceof Refusal) return new Placed(place, err, NO_SPAN);
  return err;
}
