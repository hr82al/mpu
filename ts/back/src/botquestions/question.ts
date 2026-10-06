/**
 * Один вопрос владельцу: идущий шаг, ответы прошлых шагов, единственный
 * исход и своё сообщение в чате (`docs/specs/platform/
 * telegram-questions.md`). Какой вопрос активен и сколько ждут — дело
 * ряда (`queue.ts`); вопрос отвечает за себя.
 */

import { type Button, ButtonData, type Press, STALE } from "./button.ts";
import { Card } from "./card.ts";
import type { Chat } from "./chat.ts";
import { BotFailure, type Keyboard } from "./bot_api.ts";
import {
  type Form,
  type Notice,
  notice,
  type Selection,
  type Step,
  type StepEvents,
} from "./form.ts";
import { Answered, type Outcome, Refused, type StepAnswer } from "./outcome.ts";

/** Ожидающий в ряду — вопрос или его отсутствие. */
export interface Waiting {
  /** Нажатие кнопки; ответ — подсказка подтверждения. */
  press(data: Press): string;
  /** Текст владельца; ответ — что ему сказать. */
  write(text: string): Notice;
  /**
   * Показывает себя активным; `others` — сколько ждут за ним. Не
   * показался — исход «отказ» с причиной сбоя.
   */
  draw(chat: Chat, others: number): Promise<void>;
}

/** Ответ на текст, когда отвечать не на что. */
const NOTHING_ASKED = notice("сейчас вопросов нет");

/** Ряд пуст: отвечать не на что. */
export const NOBODY: Waiting = {
  press: () => STALE,
  write: () => NOTHING_ASKED,
  draw: () => Promise.resolve(),
};

/** Кому вопрос сообщает о переменах. */
export interface Listener {
  /** Сообщение вопроса надо перерисовать. */
  changed(): void;
  /** Исход решён самим вопросом: ответ владельца или отказ показа. */
  decided(question: Question, outcome: Outcome): void;
}

/** Сообщение вопроса в чате. */
interface Message {
  /** Показывает текст и кнопки; ответ — сообщение после показа. */
  show(
    chat: Chat,
    card: Card,
    text: string,
    keyboard: Keyboard,
  ): Promise<Message>;
  /** Последняя правка строкой исхода. */
  close(chat: Chat, text: string): Promise<void>;
  /**
   * Текст владельца: доходит до шага, только если вопрос виден в чате, —
   * иначе владелец отвечал бы на то, чего не видел.
   */
  write(answer: () => Notice): Notice;
}

/** Сообщения ещё нет: показ — новое сообщение, закрывать нечего. */
const NOT_SENT: Message = {
  show: async (chat, card, text, keyboard) =>
    new Sent(await chat.show(card, text, keyboard), text, keyboard),
  close: () => Promise.resolve(),
  write: () => NOTHING_ASKED,
};

/** Отправленное сообщение и то, что в нём сейчас. */
class Sent implements Message {
  readonly #id: number;
  readonly #seen: string;

  constructor(id: number, text: string, keyboard: Keyboard) {
    this.#id = id;
    this.#seen = JSON.stringify([text, keyboard]);
  }

  /**
   * Правка, только если что-то изменилось: на правку без перемен Bot API
   * отвечает отказом «message is not modified».
   */
  async show(chat: Chat, card: Card, text: string, keyboard: Keyboard) {
    if (JSON.stringify([text, keyboard]) === this.#seen) return this;
    const edited = await chat.edit(this.#id, card, text, keyboard);
    return edited ? new Sent(this.#id, text, keyboard) : this;
  }

  close(chat: Chat, text: string): Promise<void> {
    return chat.close(this.#id, text);
  }

  write(answer: () => Notice): Notice {
    return answer();
  }
}

/** Вопрос владельцу. */
export class Question implements Waiting {
  readonly #number: number;
  readonly #run: string;
  readonly #form: Form;
  readonly #listener: Listener;
  readonly #answers: StepAnswer[] = [];
  readonly #outcome = Promise.withResolvers<Outcome>();
  #step = 0;
  #selection: Selection;
  #message: Message = NOT_SENT;
  /** Решает исход; после первого — ничего не делает. */
  #settle: (outcome: Outcome) => boolean;
  /** Слушатель шагов: ответ шага ведёт вопрос дальше. */
  readonly #events: StepEvents;

  /**
   * @param number номер вопроса в этом запуске ядра
   * @param run метка запуска ядра
   */
  constructor(options: {
    readonly number: number;
    readonly run: string;
    readonly form: Form;
    readonly listener: Listener;
  }) {
    this.#number = options.number;
    this.#run = options.run;
    this.#form = options.form;
    this.#listener = options.listener;
    this.#selection = this.#current().choice.start(this.#current().options);
    this.#settle = (outcome) => {
      this.#settle = () => false;
      this.#outcome.resolve(outcome);
      return true;
    };
    this.#events = {
      answered: (answer) => this.#answered(answer),
      changed: () => this.#listener.changed(),
    };
  }

  /** Исход: приходит один раз. */
  get outcome(): Promise<Outcome> {
    return this.#outcome.promise;
  }

  /** Решает исход; `false` — исход уже был. */
  settle(outcome: Outcome): boolean {
    return this.#settle(outcome);
  }

  press(data: Press): string {
    return data.pressOn(
      this.#run,
      this.#number,
      this.#step,
      this.#selection.press(this.#events),
    );
  }

  write(text: string): Notice {
    return this.#message.write(() =>
      this.#current().reply.write(text, this.#events)
    );
  }

  async draw(chat: Chat, others: number): Promise<void> {
    const card = this.#card();
    const tail = others > 0 ? [`ещё ждут: ${others}`] : [];
    try {
      this.#message = await this.#message.show(
        chat,
        card,
        card.text(tail),
        this.#keyboard(),
      );
    } catch (err) {
      if (!(err instanceof BotFailure)) throw err;
      // Не показался — решить его больше нечему: в чате кнопок нет.
      this.#listener.decided(this, new Refused(err.message));
    }
  }

  /** Последняя правка сообщения строкой исхода, без кнопок. */
  close(chat: Chat, outcome: Outcome): Promise<void> {
    return this.#message.close(chat, this.#card().text([outcome.line()]));
  }

  #current(): Step {
    return this.#form.steps[this.#step];
  }

  #answered(answer: StepAnswer): void {
    this.#answers.push(answer);
    if (this.#step + 1 < this.#form.steps.length) {
      this.#step += 1;
      this.#selection = this.#current().choice.start(this.#current().options);
      this.#listener.changed();
      return;
    }
    this.#listener.decided(
      this,
      new Answered(this.#answers, this.#form.answerLine),
    );
  }

  #card(): Card {
    const step = this.#current();
    const described = step.options.some((option) =>
      option.description !== undefined
    );
    const lines = described
      ? step.options.map((option) =>
        option.description === undefined
          ? `• ${option.label}`
          : `• ${option.label} — ${option.description}`
      )
      : [];
    const title = this.#form.title.line(
      this.#step + 1,
      this.#form.steps.length,
    );
    return new Card(title, step.text, lines);
  }

  #keyboard(): Keyboard {
    return this.#selection.buttons().map((row) =>
      row.map((button: Button) => ({
        text: button.label,
        data: String(
          new ButtonData(this.#run, this.#number, this.#step, button.key),
        ),
      }))
    );
  }
}
