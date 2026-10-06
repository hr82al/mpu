/**
 * Чат вопросов: вызовы Bot API вместе с памятью показанных сообщений
 * (`docs/specs/platform/telegram-questions.md`, «Сообщение»,
 * «Перезапуск», «Ошибки»). Сбой правки исход не меняет — он строкой
 * уходит в журнал службы; сбой показа отдаётся вызывающему: вопрос
 * тогда получает отказ.
 */

import {
  type BotApi,
  BotFailure,
  type Keyboard,
  NO_KEYBOARD,
} from "./bot_api.ts";
import type { Card } from "./card.ts";
import { EXPIRED_LINE } from "./outcome.ts";
import type { ShownMessages } from "./shown.ts";

/** Что нужно чату. */
export interface ChatParts {
  readonly bot: BotApi;
  readonly shown: ShownMessages;
  /** Строка в журнал службы (stderr ядра). */
  readonly diagnose: (line: string) => void;
}

/** Чат с владельцем. */
export class Chat {
  readonly #bot: BotApi;
  readonly #shown: ShownMessages;
  readonly #diagnose: (line: string) => void;

  constructor(parts: ChatParts) {
    this.#bot = parts.bot;
    this.#shown = parts.shown;
    this.#diagnose = parts.diagnose;
  }

  /**
   * Показывает вопрос новым сообщением и запоминает его до перезапуска.
   *
   * @throws BotFailure — сообщение не показано
   */
  async show(card: Card, text: string, keyboard: Keyboard): Promise<number> {
    const id = await this.#bot.send(text, keyboard);
    this.#shown.remember(id, card);
    return id;
  }

  /** Правит сообщение с кнопками; ответ — удалась ли правка. */
  async edit(
    id: number,
    card: Card,
    text: string,
    keyboard: Keyboard,
  ): Promise<boolean> {
    if (
      !await this.#tried("правка сообщения", this.#bot.edit(id, text, keyboard))
    ) {
      return false;
    }
    this.#shown.remember(id, card);
    return true;
  }

  /**
   * Последняя правка: кнопки сняты, сообщение забыто. Не удалась —
   * сообщение помнится: перезапуск ядра снимет его кнопки «истёк». Ответ —
   * сняты ли кнопки.
   */
  close(id: number, text: string): Promise<boolean> {
    return this.#finish(id, text);
  }

  /** Подтверждает нажатие; подсказка пуста — нажатие принято. */
  async ack(callback: string, hint: string): Promise<void> {
    await this.#tried("подтверждение нажатия", this.#bot.ack(callback, hint));
  }

  /** Сообщение владельцу без кнопок. */
  async say(text: string): Promise<void> {
    await this.#tried("ответ владельцу", this.#bot.send(text, NO_KEYBOARD));
  }

  /**
   * Сообщения, показанные до перезапуска ядра, — в исход «истёк»: их
   * потребители оборвались вместе с прежним процессом. Не поправилось
   * (нет сети) — запись ждёт следующего старта.
   */
  async expireShown(): Promise<void> {
    for (const { id, body } of this.#shown.all()) {
      await this.#finish(id, body.text([EXPIRED_LINE]));
    }
  }

  /**
   * Правка без кнопок; забывается поправленное и то, что поправить
   * нельзя вовсе (`400`: удалено владельцем, уже поправлено), — иначе
   * запись повторялась бы на каждом старте. Сбой сети запись хранит и
   * отвечает «кнопки не сняты».
   */
  async #finish(id: number, text: string): Promise<boolean> {
    try {
      await this.#bot.edit(id, text, NO_KEYBOARD);
    } catch (err) {
      if (!(err instanceof BotFailure)) throw err;
      this.#diagnose(`telegram: правка сообщения: ${err.message}`);
      if (!err.isFinal()) return false;
    }
    this.#shown.forget(id);
    return true;
  }

  /** Ждёт вызов; отказ Bot API — строка журнала, ответ — удался ли. */
  async #tried(what: string, call: Promise<unknown>): Promise<boolean> {
    try {
      await call;
      return true;
    } catch (err) {
      if (!(err instanceof BotFailure)) throw err;
      this.#diagnose(`telegram: ${what}: ${err.message}`);
      return false;
    }
  }
}
