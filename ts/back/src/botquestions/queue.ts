/**
 * Ряд ожидающих вопросов и единственное сообщение с кнопками
 * (`docs/specs/platform/telegram-questions.md`, «Порядок вопросов»).
 *
 * Активен голова ряда; кто активен, сколько ждут и показать ли голову
 * новым сообщением — выводится здесь, в `#redraw`, и больше нигде.
 * Правки чата идут цепочкой по одной: две одновременные правки одного
 * сообщения разошлись бы с тем, что в нём на самом деле.
 */

import { ButtonData } from "./button.ts";
import type { Chat } from "./chat.ts";
import type { Form } from "./form.ts";
import { EXPIRED, type Outcome, Withdrawn } from "./outcome.ts";
import { type Listener, NOBODY, Question, type Waiting } from "./question.ts";

/** Заданный вопрос глазами потребителя. */
export interface Asked {
  /** Исход: ровно один. */
  readonly outcome: Promise<Outcome>;
  /** Решено в другом месте; `text` — строка снятия (`решено в терминале`). */
  withdraw(text: string): void;
  /** Потребитель отключился или вышел его срок. */
  expire(): void;
}

/** Ряд вопросов. */
export class Queue {
  readonly #chat: Chat;
  readonly #run: string;
  readonly #diagnose: (line: string) => void;
  readonly #pending: Question[] = [];
  /** Решённые, чьё сообщение ещё не поправлено строкой исхода. */
  readonly #closing: { question: Question; outcome: Outcome }[] = [];
  #numbers = 0;
  /** Хвост цепочки правок чата. */
  #work: Promise<void> = Promise.resolve();

  /** @param run метка запуска ядра — в данных каждой кнопки */
  constructor(options: {
    readonly chat: Chat;
    readonly run: string;
    readonly diagnose: (line: string) => void;
  }) {
    this.#chat = options.chat;
    this.#run = options.run;
    this.#diagnose = options.diagnose;
  }

  /** Ставит вопрос в конец ряда. */
  ask(form: Form): Asked {
    this.#numbers += 1;
    const question = new Question({
      number: this.#numbers,
      run: this.#run,
      form,
      listener: this.#listenerOf(),
    });
    this.#pending.push(question);
    this.#then(() => this.#redraw());
    return {
      outcome: question.outcome,
      withdraw: (text) => this.#decide(question, new Withdrawn(text)),
      expire: () => this.#decide(question, EXPIRED),
    };
  }

  /**
   * Нажатие владельца. Подтверждение уходит раньше правок: решение
   * принимается синхронно, а правки, поставленные им в цепочку, начнутся
   * не раньше следующей микрозадачи — вызов подтверждения к тому времени
   * уже отправлен.
   */
  press(callback: string, data: string): Promise<void> {
    const hint = this.#head().press(ButtonData.parse(data));
    return this.#chat.ack(callback, hint);
  }

  /** Текст владельца — ответ активному вопросу. */
  write(text: string): Promise<void> {
    return this.#head().write(text).deliver((reply) => this.#chat.say(reply));
  }

  /** Перед первым вопросом: сообщения прошлого запуска — в «истёк». */
  expireShown(): void {
    this.#then(() => this.#chat.expireShown());
  }

  /**
   * Ждёт работу, стоящую в цепочке правок сейчас. Остановке этого
   * хватает: ядро останавливает вопросы после того, как дождалось всех
   * строк, и новой работы в цепочку уже никто не ставит.
   */
  idle(): Promise<void> {
    return this.#work;
  }

  #head(): Waiting {
    return this.#pending[0] ?? NOBODY;
  }

  #listenerOf(): Listener {
    return {
      changed: () => this.#then(() => this.#redraw()),
      decided: (question, outcome) => this.#decide(question, outcome),
    };
  }

  /** Исход вопроса: из ряда уходит, сообщение закрывается, ряд — дальше. */
  #decide(question: Question, outcome: Outcome): void {
    if (!question.settle(outcome)) return;
    this.#pending.splice(this.#pending.indexOf(question), 1);
    this.#closing.push({ question, outcome });
    this.#then(() => this.#redraw());
  }

  /**
   * Сначала закрываются решённые, затем голова — активное сообщение со
   * строкой `ещё ждут`; не показана — новым сообщением (`Question.draw`).
   * Закрытие — в той же работе, что и показ: перерисовка, стоявшая в
   * цепочке раньше исхода, иначе показала бы новую голову, пока у
   * решённого сообщения ещё есть кнопки.
   */
  async #redraw(): Promise<void> {
    for (const { question, outcome } of this.#closing.splice(0)) {
      await question.close(this.#chat, outcome);
    }
    await this.#head().draw(this.#chat, this.#pending.length - 1);
  }

  /** Ставит работу в цепочку правок. */
  #then(work: () => Promise<void>): void {
    this.#work = this.#work.then(work).catch((err) => {
      // Сюда доходит только непредвиденное: отказы Bot API разобраны
      // ниже по цепочке. Цепочка не должна застрять на одной работе.
      this.#diagnose(`telegram: вопросы: ${String(err)}`);
    });
  }
}
