/**
 * Методы Bot API, которыми ведётся чат вопросов
 * (`docs/specs/platform/telegram-questions.md`, «Стык Bot API»; голдены —
 * `fixtures/telegram-relay/bot-api/`). Порт `BotApi` — на стороне
 * потребителя: ряд и опрос ведутся с ним, тест подставляет фейк.
 *
 * Вызов метода — общий с `telegram log` (`@mpu/telegram`, `callBot`);
 * у долгого опроса предел вызова — срок опроса плюс 10 с.
 */

import type { RequestTimeouts } from "@mpu/http";
import {
  BOT_TIMEOUTS,
  BotCallError,
  type BotFailureWords,
  callBot,
} from "@mpu/telegram";
import { parseUpdates, type Update } from "./updates.ts";

import type { Rendered } from "./card.ts";

/** Кнопка в разметке сообщения. */
export interface KeyButton {
  readonly text: string;
  /** `callback_data`, не длиннее 64 байт. */
  readonly data: string;
}

/** Кнопки по рядам; пустая — кнопок нет. */
export type Keyboard = readonly (readonly KeyButton[])[];

/** Сообщение без кнопок. */
export const NO_KEYBOARD: Keyboard = [];

/** Чат с владельцем через бота. */
export interface BotApi {
  /** Отправляет сообщение; ответ — его номер. */
  send(message: Rendered, keyboard: Keyboard): Promise<number>;
  /** Правит текст и кнопки; пустые кнопки — сняты. */
  edit(id: number, message: Rendered, keyboard: Keyboard): Promise<void>;
  /** Подтверждает нажатие с подсказкой (пустая — без подсказки). */
  ack(callback: string, hint: string): Promise<void>;
  /** Долгий опрос с `offset`; отменяется сигналом. */
  updates(offset: number, signal: AbortSignal): Promise<readonly Update[]>;
}

/**
 * Отказ Bot API или транспорта. Сообщение — причина для человека
 * (`бот недоступен: 401 Unauthorized`); токен из неё вычищен вызовом
 * (`callBot` из `@mpu/telegram`).
 */
export class BotFailure extends Error {
  override name = "BotFailure";
  /** `error_code` ответа; у сбоя транспорта — `0`. */
  readonly code: number;
  /** Причина без слов «бот недоступен»: `401 Unauthorized`. */
  readonly reason: string;

  constructor(reason: string, code: number, options?: ErrorOptions) {
    super(`бот недоступен: ${reason}`, options);
    this.code = code;
    this.reason = reason;
  }

  /** Второй читатель того же бота (`409`). */
  isConflict(): boolean {
    return this.code === 409;
  }

  /**
   * Запрос негоден сам по себе (`400`: сообщения нет, оно уже такое) —
   * повтор того же вызова ответит тем же.
   */
  isFinal(): boolean {
    return this.code === 400;
  }
}

/** Срок долгого опроса, секунды (`timeout` у `getUpdates`). */
export const POLL_SECONDS = 25;

/**
 * Пределы долгого опроса: заголовки ответа приходят, только когда опрос
 * кончился, поэтому и предел заголовков — весь срок плюс запас.
 */
const POLL_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: (POLL_SECONDS + 10) * 1000,
  totalTimeoutMs: (POLL_SECONDS + 10) * 1000,
};

/** Что нужно клиенту. */
export interface BotAccess {
  readonly token: string;
  /** Чат владельца: единственный адресат. */
  readonly chatId: number;
  readonly proxy?: string;
  /** Адрес Bot API; тест — петля. */
  readonly apiBase: string;
}

/** `BotApi` поверх HTTP. */
export class HttpBotApi implements BotApi {
  readonly #access: BotAccess;

  constructor(access: BotAccess) {
    this.#access = access;
  }

  async send(message: Rendered, keyboard: Keyboard): Promise<number> {
    const result = await this.#call("sendMessage", {
      chat_id: this.#access.chatId,
      ...rendered(message),
      ...markup(keyboard),
    });
    const id = record(result)?.message_id;
    if (typeof id !== "number") {
      throw new BotFailure("не сообщён номер сообщения", 0);
    }
    return id;
  }

  async edit(id: number, message: Rendered, keyboard: Keyboard) {
    await this.#call("editMessageText", {
      chat_id: this.#access.chatId,
      message_id: id,
      ...rendered(message),
      ...markup(keyboard),
    });
  }

  async ack(callback: string, hint: string) {
    await this.#call("answerCallbackQuery", {
      callback_query_id: callback,
      ...(hint === "" ? {} : { text: hint }),
    });
  }

  async updates(offset: number, signal: AbortSignal) {
    const result = await this.#call(
      "getUpdates",
      {
        offset,
        timeout: POLL_SECONDS,
        allowed_updates: ["message", "callback_query"],
      },
      { timeouts: POLL_TIMEOUTS, signal },
    );
    return parseUpdates(result);
  }

  /** Вызов метода; ответ — поле `result` при `ok: true`. */
  async #call(
    method: string,
    body: Record<string, unknown>,
    options: { timeouts: RequestTimeouts; signal?: AbortSignal } = {
      timeouts: BOT_TIMEOUTS,
    },
  ): Promise<unknown> {
    const { token, apiBase, proxy } = this.#access;
    try {
      return await callBot(
        { token, apiBase, ...(proxy === undefined ? {} : { proxy }) },
        {
          method,
          contentType: "application/json",
          body: JSON.stringify(body),
          ...options,
        },
      );
    } catch (err) {
      if (!(err instanceof BotCallError)) throw err;
      throw err.explain(failureWords(err));
    }
  }
}

/** Слова отказа вопросов: `бот недоступен: …` (спека, «Ошибки»). */
function failureWords(cause: BotCallError): BotFailureWords<BotFailure> {
  return {
    unreachable: (reason) => new BotFailure(reason, 0, { cause }),
    unreadable: (line) =>
      new BotFailure(`ответ не JSON: ${line}`, 0, { cause }),
    refused: (code, description) =>
      new BotFailure(`${code} ${description}`, code, { cause }),
  };
}

/**
 * Текст и выделения; выделений нет — поля `entities` нет (запрос как до
 * выделений, голдены Bot API те же).
 */
function rendered(message: Rendered): Record<string, unknown> {
  return message.entities.length === 0
    ? { text: message.text }
    : { text: message.text, entities: message.entities };
}

/** Поле `reply_markup`; кнопок нет — поля нет (правка снимает кнопки). */
function markup(keyboard: Keyboard): Record<string, unknown> {
  if (keyboard.length === 0) return {};
  return {
    reply_markup: {
      inline_keyboard: keyboard.map((row) =>
        row.map((button) => ({
          text: button.text,
          callback_data: button.data,
        })),
      ),
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
