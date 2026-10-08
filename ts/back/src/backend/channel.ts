/**
 * Соединение канала Claude Code с ядром (`claude-channel.md`,
 * «Регистрация в ядре»): первый кадр — ключ сессии, дальше — ответы на
 * доставки. Пока соединение живо, канал — канал своей сессии; закрылось —
 * сессия теряет канал (её «ждёт ввода» — «сессия закрыта»).
 */

import { type Session, type Sessions, WireLink } from "../claudehook/mod.ts";
import { helloKeyOf, READY_FRAME } from "@mpu/language/frames";

/** Что соединение делает с кадром и с закрытием — по своему состоянию. */
interface Phase {
  heard(frame: string): Phase;
  closed(): void;
}

/** Соединение, которое слушает канал. */
export interface ChannelSocket {
  /** Кадр каналу; закрыто — не уходит, ответ `false`. */
  send(frame: string): boolean;
  /** Закрыть: кадр не того вида или остановка ядра. */
  close(): void;
}

/** Канал зарегистрирован в сессии. */
class Attached implements Phase {
  readonly #session: Session;
  readonly #link: WireLink;

  constructor(session: Session, link: WireLink) {
    this.#session = session;
    this.#link = link;
  }

  heard(frame: string): Phase {
    this.#link.heard(frame);
    return this;
  }

  closed(): void {
    this.#link.closed();
    this.#session.detach(this.#link);
  }
}

/** Ключа ещё нет: первый кадр — ключ сессии. */
class AwaitingKey implements Phase {
  readonly #sessions: Sessions;
  readonly #socket: ChannelSocket;

  constructor(sessions: Sessions, socket: ChannelSocket) {
    this.#sessions = sessions;
    this.#socket = socket;
  }

  heard(frame: string): Phase {
    const key = helloKeyOf(frame);
    if (key === undefined) {
      this.#socket.close();
      return CLOSING;
    }
    const link = new WireLink(this.#socket);
    const session = this.#sessions.of(key);
    session.attach(link);
    this.#socket.send(READY_FRAME);
    return new Attached(session, link);
  }

  closed(): void {}
}

/** Закрываемое без регистрации: кадры ничего не меняют. */
const CLOSING: Phase = { heard: () => CLOSING, closed: () => {} };

/** Соединение канала: кадры и закрытие — в текущее состояние. */
export class ChannelConnection {
  #phase: Phase;

  constructor(sessions: Sessions, socket: ChannelSocket) {
    this.#phase = new AwaitingKey(sessions, socket);
  }

  heard(frame: string): void {
    this.#phase = this.#phase.heard(frame);
  }

  closed(): void {
    this.#phase.closed();
    this.#phase = CLOSING;
  }
}
