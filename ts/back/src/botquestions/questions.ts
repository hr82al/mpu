/**
 * Служба вопросов владельцу (`docs/specs/platform/telegram-questions.md`):
 * ряд, опрос и память показанных сообщений вместе. Бот без ключей —
 * отдельная реализация, отвечающая отказом на любой вопрос, без опроса.
 */

import { type CacheDb, DomainError } from "../command/mod.ts";
import { botConfig, type EnvKeys, TELEGRAM_API_BASE } from "../telegram/mod.ts";
import { type BotApi, HttpBotApi } from "./bot_api.ts";
import { Chat } from "./chat.ts";
import type { Form } from "./form.ts";
import { Refused } from "./outcome.ts";
import { type Clock, Poller, REAL_CLOCK } from "./poller.ts";
import { type Asked, Queue } from "./queue.ts";
import { type ShownMessages, StoredMessages } from "./shown.ts";
import type { Inbox } from "./updates.ts";

/** Вопросы владельцу в его чате с ботом. */
export interface OwnerQuestions {
  /** Задаёт вопрос; исход — `Asked.outcome`. */
  ask(form: Form): Asked;
  /** Старт ядра: прошлые сообщения — в «истёк», опрос — в путь. */
  start(): void;
  /** Остановка ядра: опрос прерван, начатые правки дописаны. */
  stop(): Promise<void>;
}

/** Ответ на вопрос без бота — один на все вопросы. */
const UNCONFIGURED: Asked = {
  outcome: Promise.resolve(new Refused("бот не настроен")),
  withdraw: () => {},
  expire: () => {},
};

/** Ключей бота нет: вопросы — отказ, опроса нет. */
export const NO_BOT: OwnerQuestions = {
  ask: () => UNCONFIGURED,
  start: () => {},
  stop: () => Promise.resolve(),
};

/** Решить вопрос может только владелец. */
class OwnerOnly implements Inbox {
  readonly #owner: number;
  readonly #queue: Queue;
  readonly #chat: Chat;

  constructor(owner: number, queue: Queue, chat: Chat) {
    this.#owner = owner;
    this.#queue = queue;
    this.#chat = chat;
  }

  press(from: number, callback: string, data: string): Promise<void> {
    if (from !== this.#owner) return this.#chat.ack(callback, "не ваш вопрос");
    return this.#queue.press(callback, data);
  }

  /** Текст постороннего — молчание: боту пишет кто угодно. */
  write(from: number, text: string): Promise<void> {
    if (from !== this.#owner) return Promise.resolve();
    return this.#queue.write(text);
  }
}

/** Что нужно службе с ботом. */
export interface BotParts {
  readonly bot: BotApi;
  /** `TELEGRAM_BOT_ID`: чат и единственный, кто решает. */
  readonly owner: number;
  readonly shown: ShownMessages;
  readonly clock: Clock;
  /** Метка запуска ядра в данных кнопок. */
  readonly run: string;
  readonly diagnose: (line: string) => void;
}

/** Вопросы через настроенного бота. */
export class BotQuestions implements OwnerQuestions {
  readonly #queue: Queue;
  readonly #poller: Poller;
  readonly #stop = new AbortController();
  readonly #diagnose: (line: string) => void;
  #polling: Promise<void> = Promise.resolve();

  constructor(parts: BotParts) {
    this.#diagnose = parts.diagnose;
    const chat = new Chat(parts);
    this.#queue = new Queue({ chat, run: parts.run, diagnose: parts.diagnose });
    this.#poller = new Poller({
      bot: parts.bot,
      inbox: new OwnerOnly(parts.owner, this.#queue, chat),
      clock: parts.clock,
      diagnose: parts.diagnose,
    });
  }

  ask(form: Form): Asked {
    return this.#queue.ask(form);
  }

  start(): void {
    this.#queue.expireShown();
    // Опрос живёт весь процесс, и до `stop` его промис никто не ждёт:
    // непредвиденный сбой без обработчика уронил бы ядро целиком —
    // вопросы того не стоят. Он уходит в журнал, как сбой цепочки правок.
    this.#polling = this.#poller.run(this.#stop.signal).catch((err) => {
      this.#diagnose(`telegram: опрос остановлен: ${String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#polling;
    await this.#queue.idle();
  }
}

/** Метка запуска: восемь знаков `[a-z0-9]`. */
function runMark(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

/** Что нужно сборке службы сверх env-файла. */
export interface QuestionsDeps {
  /** Кэш-БД; нет каталога состояния — бросает. */
  readonly openCacheDb: () => CacheDb;
  readonly diagnose: (line: string) => void;
}

/**
 * Служба по ключам env-файла: нет `TELEGRAM_BOT_TOKEN` или
 * `TELEGRAM_BOT_ID` — `NO_BOT`. Ключи читаются один раз — при старте
 * ядра.
 */
export function ownerQuestions(
  env: EnvKeys,
  deps: QuestionsDeps,
): OwnerQuestions {
  const token = env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const id = env.get("TELEGRAM_BOT_ID") ?? "";
  if (token === "" || id === "") return NO_BOT;
  let config;
  try {
    config = botConfig(env);
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    // Ключ есть, но непригоден (id не число, прокси не той схемы):
    // для вопросов это то же «бот не настроен», причина — в журнал.
    deps.diagnose(
      `${err.message}; вопросы в Telegram отключены`,
    );
    return NO_BOT;
  }
  return new BotQuestions({
    bot: new HttpBotApi({
      token: config.token,
      chatId: config.chatId,
      apiBase: TELEGRAM_API_BASE,
      ...(config.proxy === undefined ? {} : { proxy: config.proxy }),
    }),
    owner: config.chatId,
    shown: new StoredMessages(deps.openCacheDb, deps.diagnose),
    clock: REAL_CLOCK,
    run: runMark(),
    diagnose: deps.diagnose,
  });
}
