/**
 * Исполнение строки вызова: сообщение уходит приёмнику, ответ становится
 * следующим приёмником. Исполнение отстаёт от разбора на одно звено —
 * иначе справка не могла бы оставить последнее сообщение неисполненным.
 */

import { MessageParseError, readMessage } from "../messages/mod.ts";
import type { Call, Outcome, Receiver, Sent, Walker } from "./protocol.ts";
import { HELP_SELECTOR } from "./protocol.ts";
import { Refusal, Rejection } from "./refusal.ts";
import { sentOf } from "./sent.ts";
import { Trail } from "./trail.ts";

/** Чем кончается строка. */
interface Mode {
  finish(walk: Walk): Promise<Outcome>;
}

/** Последнее сообщение исполняется; итог — его ответ. */
const NORMAL: Mode = {
  finish: (walk) => walk.settle(),
};

/** Последнее сообщение не исполняется; итог — справка его метода. */
const HELP: Mode = {
  finish: (walk) => Promise.resolve(walk.explain()),
};

class Walk implements Walker {
  readonly #trail = new Trail();
  #pending: Call;
  #mode: Mode = NORMAL;

  constructor(origin: Call) {
    this.#pending = origin;
  }

  /** Описание для разбора — от вида того, кто примет следующее сообщение. */
  read(words: readonly string[]) {
    try {
      return readMessage(words, this.#pending.result().parsing());
    } catch (err) {
      if (!(err instanceof MessageParseError)) throw err;
      throw new Rejection(err.message, { cause: err });
    }
  }

  askHelp() {
    this.#mode = HELP;
  }

  async send(sent: Sent) {
    const receiver = await this.#advance();
    this.#pending = this.#refused(() => receiver.lookup(sent));
  }

  finish(): Promise<Outcome> {
    return this.#mode.finish(this);
  }

  /**
   * Исполняет последнее сообщение и спрашивает итог у ответа. Отказ
   * ответа в конце строки получает спереди адрес, как отказ до неё.
   */
  async settle(): Promise<Outcome> {
    const before = this.#trail.copy();
    const receiver = await this.#advance();
    const path = this.#trail.links();
    return await this.#refusedAsync(() =>
      receiver.final({
        value: (value) => ({ path, value }),
        exit: (exit) => ({ path, exit }),
        links: () => [...path],
        text: () => this.#trail.text(),
        through: (gate) => this.#trail.through(gate),
        object: () => ({
          path,
          object: this.#refused(() => this.#pending.help(before)),
        }),
      })
    );
  }

  /** Справка метода последнего сообщения, без его исполнения. */
  explain(): Outcome {
    const shown = this.#trail.copy();
    this.#pending.trace(shown);
    return {
      path: [HELP_SELECTOR, ...shown.links()],
      value: this.#refused(() => this.#pending.help(this.#trail)),
    };
  }

  async #advance(): Promise<Receiver> {
    const receiver = await this.#refusedAsync(() => this.#pending.perform());
    this.#pending.trace(this.#trail);
    return receiver;
  }

  #refused<T>(act: () => T): T {
    try {
      return act();
    } catch (err) {
      throw this.#rejection(err);
    }
  }

  async #refusedAsync<T>(act: () => Promise<T>): Promise<T> {
    try {
      return await act();
    } catch (err) {
      throw this.#rejection(err);
    }
  }

  /** Отказ объекта получает спереди путь до приёмника. */
  #rejection(err: unknown): unknown {
    if (!(err instanceof Refusal)) return err;
    return new Rejection(`${this.#trail.address()}: ${err.message}`, {
      cause: err,
    });
  }
}

/**
 * Исполняет строку вызова на дереве объектов.
 *
 * @param words слова строки, как их отдала оболочка
 * @param origin корень дерева (`origin`)
 * @returns итог-данные, итог-объект или отказ с кодом 2
 */
export async function runChain(
  words: readonly string[],
  origin: Call,
): Promise<Outcome> {
  const walk = new Walk(origin);
  try {
    let rest = words;
    do {
      const step = walk.read(rest);
      rest = step.rest;
      await sentOf(step.message).enter(walk);
    } while (rest.length > 0);
    return await walk.finish();
  } catch (err) {
    if (!(err instanceof Rejection)) throw err;
    return { error: err.message, code: 2 };
  }
}
