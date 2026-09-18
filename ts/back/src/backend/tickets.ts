/**
 * Номера подтверждения (`platform/back-http-line.md`): строка, ждущая
 * ответа, живёт здесь, наружу — только номер. Номер одноразовый, помнит
 * дверь и вызывающего; срок и отзыв — от ожидания самой строки.
 */

import type { Caller } from "./caller.ts";
import type { Door } from "./door.ts";
import type { Line, Revocable } from "./line.ts";

/** Байт случайности номера: 32 шестнадцатеричных знака. */
const TICKET_BYTES = 16;

/** Случайный номер из 32 шестнадцатеричных знаков. */
export function randomTicket(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(TICKET_BYTES)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Выданный номер: его текст и отзыв. */
export interface Ticket extends Revocable {
  readonly id: string;
}

interface Held {
  readonly line: Line;
  readonly door: Door;
  readonly caller: Caller;
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
    this.#held.set(id, { line, door, caller });
    return { id, revoke: () => this.#held.delete(id) };
  }

  /**
   * Строка по номеру — только той же двери и тому же вызывающему; иначе
   * — ничего, и номер чужому не расходуется. Номер расходует ответ:
   * ожидание строки кончается и отзывает его (`issue`), — поэтому второй
   * раз его уже нет.
   */
  take(id: string, door: Door, caller: Caller): Line | undefined {
    const held = this.#held.get(id);
    if (held === undefined) return undefined;
    if (held.door !== door || held.caller !== caller) return undefined;
    return held.line;
  }
}
