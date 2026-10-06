/**
 * Ряд ожидающих вопросов и единственное сообщение с кнопками
 * (`docs/specs/platform/telegram-questions.md`, «Порядок вопросов», «R2»).
 *
 * Активен голова ряда (порядок — `row.ts`); кто активен, сколько ждут и
 * показать ли голову новым сообщением — выводится здесь, в `#redraw`, и
 * больше нигде. Голова, сменившаяся без исхода (её обогнал срочный или
 * владелец её отложил), уступает место — `#aside`.
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
  readonly #row = new Row<Question>();
  /** Решённые, чьё сообщение ещё не поправлено строкой исхода. */
  readonly #closing: { question: Question; outcome: Outcome }[] = [];
  /** Уступившие место, чьё сообщение ещё не поправлено. */
  readonly #aside: { waiting: Waiting; line: string }[] = [];
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
    const before = this.#head();
    this.#row.add(question, form.kind);
    this.#yielded(before, AFTER_URGENT);
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
    if (this.#row.size() < 2) return NOTHING_ELSE;
    const before = this.#head();
    this.#row.toEnd(question);
    this.#yielded(before, POSTPONED);
    this.#then(() => this.#redraw());
    return ACCEPTED;
  }

  /** Голова `before` сменилась без исхода — уступает место строкой `line`. */
  #yielded(before: Waiting, line: string): void {
    if (this.#head() !== before) this.#aside.push({ waiting: before, line });
  }

  /**
   * Сначала уступившие место снимают кнопки, затем закрываются решённые,
   * затем голова — активное сообщение со строкой `ещё ждут`; не показана
   * — новым сообщением (`Question.draw`). Всё — в одной работе:
   * перерисовка, стоявшая в цепочке раньше, иначе показала бы новую
   * голову, пока у прежней ещё есть кнопки. Уступивший — раньше закрытия:
   * решённый после того, как уступил, правится строкой исхода последним.
   */
  async #redraw(): Promise<void> {
    for (const { waiting, line } of this.#aside.splice(0)) {
      await waiting.putAside(this.#chat, line);
    }
    for (const { question, outcome } of this.#closing.splice(0)) {
      await question.close(this.#chat, outcome);
    }
    await this.#head().draw(this.#chat, this.#row.size() - 1);
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
