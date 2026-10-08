/**
 * Порядок ряда ожидающих (`docs/specs/platform/telegram-questions.md`,
 * «R2: вид вопроса и порядок ряда»): все срочные по времени прихода,
 * затем все «ждёт ввода» по времени прихода. Место в ряду выбирает вид
 * вопроса, а не ветка ряда по нему.
 */

/** Полоса ряда: свои по времени прихода. */
class Lane<T> {
  readonly #items: T[] = [];

  push(item: T): void {
    this.#items.push(item);
  }

  /** Убирает `item`; ответ — был ли он в полосе. */
  remove(item: T): boolean {
    const at = this.#items.indexOf(item);
    if (at < 0) return false;
    this.#items.splice(at, 1);
    return true;
  }

  /**
   * Переносит `item` в конец полосы, если он в ней; ответ — встал ли он
   * за кем-то (в полосе есть другие).
   */
  toEnd(item: T): boolean {
    if (!this.#items.includes(item) || this.#items.length < 2) return false;
    this.remove(item);
    this.#items.push(item);
    return true;
  }

  /** Есть ли `item` в полосе. */
  has(item: T): boolean {
    return this.#items.includes(item);
  }

  /** Свои по порядку — копией. */
  items(): readonly T[] {
    return [...this.#items];
  }
}

/** Полосы ряда — то, из чего вид выбирает свою. */
export interface Lanes<T> {
  readonly urgent: Lane<T>;
  readonly waiting: Lane<T>;
}

/** Вид вопроса: в какой полосе ряда он стоит. Задаёт потребитель. */
export interface Kind {
  laneOf<T>(lanes: Lanes<T>): Lane<T>;
}

/** Срочный — право, AskUserQuestion: обгоняет «ждёт ввода». */
export const URGENT: Kind = { laneOf: (lanes) => lanes.urgent };

/** «Ждёт ввода» — конец хода сессии: после всех срочных. */
export const WAITS_INPUT: Kind = { laneOf: (lanes) => lanes.waiting };

/** Ряд: срочные, затем ждущие. */
export class Row<T> {
  readonly #lanes: Lanes<T> = { urgent: new Lane(), waiting: new Lane() };

  /** Ставит `item` вида `kind` в конец его полосы. */
  add(item: T, kind: Kind): void {
    kind.laneOf(this.#lanes).push(item);
  }

  /** Убирает `item` из ряда. */
  remove(item: T): void {
    if (!this.#lanes.urgent.remove(item)) this.#lanes.waiting.remove(item);
  }

  /** Переносит `item` в конец его полосы; ответ — встал ли за кем-то. */
  toEnd(item: T): boolean {
    return this.#lanes.urgent.toEnd(item) || this.#lanes.waiting.toEnd(item);
  }

  /** Стоит ли `item` в ряду. */
  has(item: T): boolean {
    return this.#lanes.urgent.has(item) || this.#lanes.waiting.has(item);
  }

  /** Первый в ряду; ряд пуст — `none`. */
  head<U>(none: U): T | U {
    return this.#all()[0] ?? none;
  }

  /** Сколько в ряду. */
  size(): number {
    return this.#all().length;
  }

  #all(): readonly T[] {
    return [...this.#lanes.urgent.items(), ...this.#lanes.waiting.items()];
  }
}
