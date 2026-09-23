/**
 * Исполнение строки вызова: сообщение уходит приёмнику, ответ становится
 * следующим приёмником. Исполнение отстаёт от разбора на одно звено —
 * иначе справка не могла бы оставить последнее сообщение неисполненным.
 */

import {
  GRAMMAR,
  type Message,
  MessageParseError,
  type ParsedMessage,
  readMessage,
  resolvedMessage,
  StrayWord,
} from "../messages/mod.ts";
import type { Help } from "./help.ts";
import type {
  Call,
  Outcome,
  Receiver,
  ResultKind,
  Sent,
  Trace,
  ValueEvaluation,
  Walker,
} from "./protocol.ts";
import { HELP_SELECTOR } from "./protocol.ts";
import { ANSWERED, answered, HELP_DOC } from "./result.ts";
import { Refusal, Rejection } from "./refusal.ts";
import { sentOf } from "./sent.ts";
import { Trail } from "./trail.ts";

/**
 * `help` объекту, который обозначает выражение до него: выражение не
 * вычисляется — справку о его результате даёт вид результата. Ответ —
 * объект-справка.
 */
class HelpCall implements Call {
  readonly #of: Call;
  readonly #at: Trail;

  /**
   * @param of последнее, ещё не исполненное сообщение выражения
   * @param at путь до него
   */
  constructor(of: Call, at: Trail) {
    this.#of = of;
    this.#at = at;
  }

  trace(trail: Trace) {
    this.#of.trace(trail);
    trail.step(HELP_SELECTOR, HELP_SELECTOR);
  }

  result(): ResultKind {
    return ANSWERED;
  }

  /** Справка ответа на `help`: путь — путь выражения со словом `help`. */
  help(trail: Trace): Help {
    const of = this.#of.help(trail).data().path;
    return ANSWERED.about(`${of} ${HELP_SELECTOR}`, HELP_DOC);
  }

  perform(): Promise<Receiver> {
    return Promise.resolve(answered(this.#of.help(this.#at)));
  }
}

class Walk implements Walker {
  readonly #trail = new Trail();
  #pending: Call;

  constructor(origin: Call) {
    this.#pending = origin;
  }

  /**
   * Описание для разбора — от вида того, кто примет следующее сообщение.
   * Лишнее слово за значением называется с адресом до него.
   */
  read(words: readonly string[]) {
    try {
      return readMessage(words, this.#pending.result().parsing());
    } catch (err) {
      if (err instanceof StrayWord) throw this.#stray(err);
      if (!(err instanceof MessageParseError)) throw err;
      throw new Rejection(err.message, { cause: err });
    }
  }

  #stray(err: StrayWord): Rejection {
    const shown = this.#trail.copy();
    this.#pending.trace(shown);
    const at = shown.textWith(err.taken.join(" "));
    const hint = this.#pending.result().remedy(err.word, err.after)
      .spell(shown.address(), err.taken);
    return new Rejection(`${at}: ${err.message}${hint}`, { cause: err });
  }

  help() {
    this.#pending = new HelpCall(this.#pending, this.#trail.copy());
  }

  /**
   * Сообщение с вычисленными значениями. Отказ вычисления получает
   * спереди адрес того, кто примет сообщение, — как лишнее слово.
   */
  async valued(
    message: ParsedMessage,
    evaluation: ValueEvaluation,
  ): Promise<Message> {
    const kind = this.#pending.result().reflect();
    try {
      return await resolvedMessage(message, {
        group: (words, key, ready) => evaluation.group(words, key, ready),
        stdin: (key) => evaluation.stdin(key, kind.prompts(key)),
      });
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      const shown = this.#trail.copy();
      this.#pending.trace(shown);
      const at = shown.address();
      const hint = err.remedy.spell(at, []);
      throw new Rejection(`${at}: ${err.message}${hint}`, { cause: err });
    }
  }

  async send(sent: Sent) {
    const receiver = await this.#advance();
    this.#pending = this.#refused(() => receiver.lookup(sent));
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
        shown: (item) => ({ path, value: item.text() }),
        exit: (exit) => ({ path, exit }),
        links: () => [...path],
        text: () => this.#trail.text(),
        through: (gate) => this.#trail.through(gate),
        object: () => ({
          path,
          object: this.#refused(() => this.#pending.help(before).text()),
        }),
      })
    );
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
    const address = this.#trail.address();
    const hint = err.remedy.spell(address, []);
    return new Rejection(`${address}: ${err.message}${hint}`, {
      cause: err,
    });
  }
}

/**
 * Исполняет строку вызова на дереве объектов.
 *
 * @param words слова строки, как их отдала оболочка
 * @param origin корень дерева (`origin`)
 * @param evaluation где вычисляются группы и `stdin` на месте значений
 * @returns итог-данные, итог-объект, код группы или отказ с кодом 2
 */
export async function runChain(
  words: readonly string[],
  origin: Call,
  evaluation: ValueEvaluation = NO_EVALUATION,
): Promise<Outcome> {
  const walk = new Walk(origin);
  try {
    // Открытие группы первым словом — то же, что без него
    // (`platform/line-grammar.md`): группу закрывает `end` от начала.
    let rest = words[0] === GRAMMAR.open ? words.slice(1) : words;
    do {
      const step = walk.read(rest);
      rest = step.rest;
      // Значения — до сообщения: внешнее не уходит, пока группа не дала
      // значение (`platform/value-expression.md`, «Инварианты»).
      const message = await walk.valued(step.message, evaluation);
      await sentOf(message).enter(walk);
    } while (rest.length > 0);
    return await walk.settle();
  } catch (err) {
    if (err instanceof GroupExit) return { path: [], exit: err.code };
    if (!(err instanceof Rejection)) throw err;
    return { error: err.message, code: 2 };
  }
}

/** Группа значения кончилась кодом ≠ 0: строка кончается им же. */
export class GroupExit extends Error {
  override name = "GroupExit";
  readonly code: number;

  constructor(code: number) {
    super(`группа значения кончилась кодом ${code}`);
    this.code = code;
  }
}

/** Значений-выражений у строки нет: отказ, а не молчание. */
const NO_EVALUATION: ValueEvaluation = {
  group: () => {
    throw new Refusal("выражение значения здесь не вычисляется");
  },
  stdin: () => {
    throw new Refusal("stdin здесь не читается");
  },
};
