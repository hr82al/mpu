/**
 * Один вызов метода Bot API: адрес с токеном, транспорт с пределами и
 * прокси, разбор `ok`/`result`/`error_code` (`telegram-log.md`,
 * `platform/telegram-questions.md`, «Стык Bot API»). Общий у
 * отправки в бота (`./bot.ts`) и вопросов владельцу
 * (`ts/back/src/botquestions/`): правила вызова одни, а слова отказа у каждого
 * свои — их задаёт потребитель (`BotFailureWords`).
 */

import {
  firstLine,
  HttpCallError,
  httpSend,
  type RequestTimeouts,
} from "@mpu/http";

/** Адрес Bot API; параметром — чтобы тест ходил на петлю, а не наружу. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Пределы обычного вызова — шире умолчания транспорта (3s/10s).
 * Умолчание отмерено на стенд в локальной сети; здесь путь другой:
 * внешний узел, а у большинства операторов ещё и прокси, добавляющий
 * рукопожатие. На умолчании первый же живой вызов упирался в
 * «no response headers within 3000ms», не дойдя до Telegram.
 */
export const BOT_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: 15_000,
  totalTimeoutMs: 30_000,
};

/** Куда звонить: токен, прокси, адрес. */
export interface BotEndpoint {
  readonly token: string;
  /** Прокси-URL; не задан — поля нет. */
  readonly proxy?: string;
  readonly apiBase: string;
}

/** Вызов метода: готовое тело с объявленным типом. */
export interface BotRequest {
  readonly method: string;
  readonly contentType: string;
  readonly body: string | Uint8Array<ArrayBuffer>;
  readonly timeouts: RequestTimeouts;
  /** Отмена снаружи (долгий опрос при остановке ядра). */
  readonly signal?: AbortSignal;
}

/** Слова отказа потребителя; тексты уже без токена. */
export interface BotFailureWords<T> {
  /** Сбой транспорта: причина одной строкой. */
  unreachable(reason: string): T;
  /** Ответ не JSON: его первая строка. */
  unreadable(line: string): T;
  /** `ok: false`: `error_code` (нет — 0) и `description`. */
  refused(code: number, description: string): T;
}

/** Отказ вызова: потребитель называет его своими словами. */
export class BotCallError extends Error {
  override name = "BotCallError";
  readonly #explain: <T>(words: BotFailureWords<T>) => T;

  constructor(
    message: string,
    explain: <T>(words: BotFailureWords<T>) => T,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.#explain = explain;
  }

  explain<T>(words: BotFailureWords<T>): T {
    return this.#explain(words);
  }
}

/**
 * Вызывает метод; ответ — поле `result` при `ok: true`.
 *
 * @throws BotCallError — транспорт, не JSON или `ok: false`
 */
export async function callBot(
  endpoint: BotEndpoint,
  request: BotRequest,
): Promise<unknown> {
  // Токен лежит в адресе: рантайм кладёт адрес в текст ошибки
  // транспорта, а чужое тело может его повторить. Чистится каждая
  // строка, уходящая потребителю.
  const clean = (text: string) => text.replaceAll(endpoint.token, "<токен>");
  let text: string;
  try {
    text = (
      await httpSend(
        new URL(`${endpoint.apiBase}/bot${endpoint.token}/${request.method}`),
        {
          method: "POST",
          headers: { "content-type": request.contentType },
          body: request.body,
          timeouts: request.timeouts,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          // Прокси адресный: он нужен пути наружу, а обращения к стенду
          // ходят напрямую (`telegram-log.md`, «Конфигурация»).
          ...(endpoint.proxy === undefined ? {} : { proxy: endpoint.proxy }),
        },
      )
    ).text;
  } catch (err) {
    if (!(err instanceof HttpCallError)) throw err;
    const reason = clean(firstLine(err.message));
    throw new BotCallError(reason, (words) => words.unreachable(reason), {
      cause: err,
    });
  }
  return resultOf(text, clean);
}

/** `result` ответа либо отказ. */
function resultOf(text: string, clean: (text: string) => string): unknown {
  let reply: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(text);
    reply =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
  } catch {
    // Не JSON — это не Bot API на том конце: шлюз, прокси или
    // заглушка. Молча считать успехом нельзя.
    const line = clean(firstLine(text));
    throw new BotCallError(line, (words) => words.unreadable(line));
  }
  if (reply?.ok === true) return reply.result;
  const code = typeof reply?.error_code === "number" ? reply.error_code : 0;
  const description = clean(
    typeof reply?.description === "string" ? reply.description : "без описания",
  );
  throw new BotCallError(`${code} ${description}`, (words) =>
    words.refused(code, description),
  );
}
