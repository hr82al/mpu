/**
 * Канал сессии в ядре (`claude-channel.md`, «Регистрация в ядре»): ядро
 * шлёт каналу текст владельца кадром `deliver` с номером и ждёт ответа
 * `delivered`/`failed` с тем же номером. Закрытие соединения — отказ всем
 * ждущим доставкам.
 */

import { deliverFrame, readChannelAnswer } from "../frames/mod.ts";
import { ChannelReach, type Reach } from "./reach.ts";
import type { Link, Session } from "./sessions.ts";

/**
 * Ответ на доставку, которой не ждут (повтор, чужой номер): ничего не
 * решает — исход доставки один.
 */
const UNAWAITED = (_delivered: boolean) => {};

/** Куда канал ядра пишет кадры: соединение с клиентом канала. */
export interface ChannelWire {
  /** Кадр в соединение; ответ — принят ли (соединение открыто). */
  send(frame: string): boolean;
}

/** Соединение закрыто: кадров не принимает. */
const CLOSED_WIRE: ChannelWire = { send: () => false };

/** Канал сессии поверх соединения с клиентом `mpu claude-channel`. */
export class WireLink implements Link {
  #wire: ChannelWire;
  /** Доставки, ждущие ответа канала, по номеру. */
  readonly #waiting = new Map<number, (delivered: boolean) => void>();
  #numbers = 0;

  constructor(wire: ChannelWire) {
    this.#wire = wire;
  }

  deliver(text: string): Promise<boolean> {
    this.#numbers += 1;
    const id = this.#numbers;
    const answer = Promise.withResolvers<boolean>();
    // Ожидание — до отправки: ответ может прийти раньше, чем `send` вернёт.
    this.#waiting.set(id, answer.resolve);
    if (!this.#wire.send(deliverFrame(id, text))) this.#answer(id, false);
    return answer.promise;
  }

  reach(session: Session): Reach {
    return new ChannelReach(session);
  }

  /** Кадр от канала: ответ на доставку; чужой номер или форма — мимо. */
  heard(frame: string): void {
    readChannelAnswer(frame, {
      delivered: (id) => this.#answer(id, true),
      failed: (id) => this.#answer(id, false),
      unknown: () => {},
    });
  }

  /** Соединение закрылось: ждущие доставки — отказ, новых не будет. */
  closed(): void {
    this.#wire = CLOSED_WIRE;
    for (const answer of this.#waiting.values()) answer(false);
    this.#waiting.clear();
  }

  #answer(id: number, delivered: boolean): void {
    const answer = this.#waiting.get(id) ?? UNAWAITED;
    this.#waiting.delete(id);
    answer(delivered);
  }
}
