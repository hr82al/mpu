/**
 * Ряд ожидающих вопросов и единственное сообщение с кнопками
 * (`docs/specs/platform/telegram-questions.md`, «Порядок вопросов», «R2»).
 *
 * Активен голова ряда (порядок — `row.ts`); кто активен, сколько ждут и
 * показать ли голову новым сообщением — выводится здесь, в `#redraw`, и
 * больше нигде. Показанная голова, сменившаяся без исхода (её обогнал
 * срочный или владелец её отложил), уступает место — решает `#redraw`
 * по тому, что в чате нарисовано, а не по смене головы в ряду: срочный,
 * снятый раньше показа, показанного не трогает.
 * Правки чата идут цепочкой по одной: две одновременные правки одного
 * сообщения разошлись бы с тем, что в нём на самом деле.
 */

import { ACCEPTED, ButtonData, NOTHING_ELSE } from "./button.ts";
import type { Chat } from "./chat.ts";
import type { Form } from "./form.ts";
import { EXPIRED, type Outcome, Withdrawn } from "./outcome.ts";
import { type Listener, NOBODY, Question, type Waiting } from "./question.ts";
import { Row } from "./row.ts";

/** Строка уступившего место: его обогнал срочный. */
const AFTER_URGENT = "↷ ждёт после срочного";

/** Строка уступившего место: владелец отложил (`Позже`). */
const POSTPONED = "↷ отложено";

/** Заданный вопрос глазами потребителя. */
export interface Asked {
  /** Исход: ровно один. */
  readonly outcome: Promise<Outcome>;
  /**
   * Вопрос в ряду: перерисовка после постановки прошла — показан, стоит
   * за другими или получил отказ показа (тогда исход решён раньше).
   */
  readonly placed: Promise<void>;
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
  readonly #row = new Row<Waiting>();
  /** Решённые, чьё сообщение ещё не поправлено строкой исхода. */
  readonly #closing: { question: Question; outcome: Outcome }[] = [];
  /** Последняя нарисованная голова. */
  #shown: Waiting = NOBODY;
  /** Строка, которой нарисованная голова уступит место. */
  #yieldLine = AFTER_URGENT;
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
    this.#row.add(question, form.kind);
    const placed = this.#then(() => this.#redraw());
    return {
      outcome: question.outcome,
      placed,
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
    return this.#row.head(NOBODY);
  }

  #listenerOf(): Listener {
    return {
      changed: () => this.#then(() => this.#redraw()),
      decided: (question, outcome) => this.#decide(question, outcome),
      postponed: (question) => this.#postpone(question),
    };
  }

  /** Исход вопроса: из ряда уходит, сообщение закрывается, ряд — дальше. */
  #decide(question: Question, outcome: Outcome): void {
    if (!question.settle(outcome)) return;
    this.#row.remove(question);
    this.#closing.push({ question, outcome });
    this.#then(() => this.#redraw());
  }

  /**
   * `Позже`: вопрос — в конец своего вида; ждущих, кроме него, нет —
   * подсказка, вопрос активен.
   */
  #postpone(question: Question): string {
    if (!this.#row.toEnd(question)) return NOTHING_ELSE;
    this.#yieldLine = POSTPONED;
    this.#then(() => this.#redraw());
    return ACCEPTED;
  }

  /**
   * Сначала нарисованная голова, сменившаяся без исхода, уступает место,
   * затем закрываются решённые, затем голова — активное сообщение со
   * строкой `ещё ждут`; не показана — новым сообщением (`Question.draw`).
   * Всё — в одной работе: перерисовка, стоявшая в цепочке раньше, иначе
   * показала бы новую голову, пока у прежней ещё есть кнопки.
   */
  async #redraw(): Promise<void> {
    if (this.#head() !== this.#shown && this.#row.has(this.#shown)) {
      await this.#shown.putAside(this.#chat, this.#yieldLine);
    }
    for (const { question, outcome } of this.#closing.splice(0)) {
      await question.close(this.#chat, outcome);
    }
    // Голова — после правок: ряд мог смениться, пока они шли; новая смена
    // уступит место следующей перерисовкой.
    const head = this.#head();
    await head.draw(this.#chat, this.#row.size() - 1);
    this.#shown = head;
    this.#yieldLine = AFTER_URGENT;
  }

  /** Ставит работу в цепочку правок; ответ — её конец. */
  #then(work: () => Promise<void>): Promise<void> {
    this.#work = this.#work.then(work).catch((err) => {
      // Сюда доходит только непредвиденное: отказы Bot API разобраны
      // ниже по цепочке. Цепочка не должна застрять на одной работе.
      this.#diagnose(`telegram: вопросы: ${String(err)}`);
    });
    return this.#work;
  }
}
