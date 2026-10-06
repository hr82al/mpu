/**
 * Номера подтверждения (`platform/back-http-line.md`): строка, ждущая
 * ответа, живёт здесь, наружу — только номер. Номер одноразовый, помнит
 * дверь и вызывающего; срок и отзыв — от ожидания самой строки.
 */

import type { Caller } from "./caller.ts";
import type { Door } from "./door.ts";
import type { Line, Posed, Rival } from "./line.ts";

/** Байт случайности номера: 32 шестнадцатеричных знака. */
const TICKET_BYTES = 16;

/** Случайный номер из 32 шестнадцатеричных знаков. */
export function randomTicket(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(TICKET_BYTES)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Выданный номер: его текст, отзыв и решение в другом месте. */
export interface Ticket extends Posed {
  readonly id: string;
}

/** Чем кончилось ожидание решения в другом месте. */
export interface Settlement {
  read<T>(reader: SettlementReader<T>): T;
}

/** Чтение исхода ожидания. */
export interface SettlementReader<T> {
  /**
   * Решено в другом месте: строка ждёт, чтобы её продолжение забрали
   * запросом с номером.
   *
   * @param said что сказать каналу: `решено в Telegram — да`
   */
  decided(said: string): T;
  /** Ждать нечего: номер отозван или запрос ушёл раньше решения. */
  gone(): T;
}

function decided(said: string): Settlement {
  return { read: (reader) => reader.decided(said) };
}

const GONE: Settlement = { read: (reader) => reader.gone() };

/** Строка, ждущая ответа по номеру, глазами запроса с этим номером. */
export interface Claim {
  readonly line: Line;
  /** Ответ строке: присланный — или решённый в другом месте раньше него. */
  answer(given: string): string;
  /**
   * Ждёт решения в другом месте (`platform/ask-telegram.md` [D.3]):
   * у строки с номером доставки нет, и сказать о решении ей нечем —
   * клиент узнаёт его сам и забирает продолжение ответом по номеру.
   *
   * @param signal запрос ушёл: ждать перестают, строку это не трогает
   */
  settled(signal: AbortSignal): Promise<Settlement>;
}

/**
 * Номер в хранилище: строка, дверь, вызывающий и решение в другом месте.
 * Решение помнится, пока его не забрали: продолжение строки без доставки
 * ушло бы в никуда.
 */
class Held implements Ticket, Claim {
  readonly id: string;
  readonly line: Line;
  readonly door: Door;
  readonly caller: Caller;
  readonly #forget: () => void;
  readonly #outcome = Promise.withResolvers<Settlement>();
  #answer: (given: string) => string = (given) => given;

  constructor(options: {
    readonly id: string;
    readonly line: Line;
    readonly door: Door;
    readonly caller: Caller;
    readonly forget: () => void;
  }) {
    this.id = options.id;
    this.line = options.line;
    this.door = options.door;
    this.caller = options.caller;
    this.#forget = options.forget;
  }

  revoke(): void {
    this.#forget();
    this.#outcome.resolve(GONE);
  }

  settle(_line: Line, answer: string, said: string): void {
    this.#answer = () => answer;
    this.#outcome.resolve(decided(said));
  }

  /** Снять ли вопрос у клиента — решает дверь номера. */
  admits(rival: Rival): Rival {
    return this.door.ticketRival(rival);
  }

  answer(given: string): string {
    return this.#answer(given);
  }

  async settled(signal: AbortSignal): Promise<Settlement> {
    const left = Promise.withResolvers<Settlement>();
    const leave = () => left.resolve(GONE);
    signal.addEventListener("abort", leave, { once: true });
    if (signal.aborted) leave();
    try {
      return await Promise.race([this.#outcome.promise, left.promise]);
    } finally {
      signal.removeEventListener("abort", leave);
    }
  }
}

/** Хранилище номеров сервера. */
export class Tickets {
  readonly #held = new Map<string, Held>();
  readonly #newId: () => string;

  /** @param newId генератор номера */
  constructor(newId: () => string = randomTicket) {
    this.#newId = newId;
  }

  /** Номер для строки, ждущей ответа на двери `door` от `caller`. */
  issue(line: Line, door: Door, caller: Caller): Ticket {
    const id = this.#newId();
    const held = new Held({
      id,
      line,
      door,
      caller,
      forget: () => this.#held.delete(id),
    });
    this.#held.set(id, held);
    return held;
  }

  /**
   * Строка по номеру — только той же двери и тому же вызывающему; иначе
   * — ничего, и номер чужому не расходуется. Номер расходует ответ:
   * ожидание строки кончается и отзывает его (`issue`), — поэтому второй
   * раз его уже нет.
   */
  take(id: string, door: Door, caller: Caller): Claim | undefined {
    const held = this.#held.get(id);
    if (held === undefined) return undefined;
    if (held.door !== door || held.caller !== caller) return undefined;
    return held;
  }
}
