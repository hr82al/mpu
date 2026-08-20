/**
 * Отправка в личного бота по Bot API (`docs/specs/telegram-log.md`).
 *
 * Bot API — JSON поверх HTTP, поэтому клиента протокола здесь нет:
 * транспорт общий с прочими внешними системами (`../http/mod.ts`) — от
 * него два предела времени и причина отказа одной строкой. MTProto
 * (`./session.ts`) не задействован: другой протокол и другая модель
 * доступа, и команда не должна платить за крипту MTProto.
 *
 * Апдейты не читаются намеренно: адресат берётся только из
 * конфигурации, иначе сообщение могло бы уйти постороннему,
 * написавшему боту (спека, «CLI-контракт»).
 */

import {
  firstLine,
  HttpCallError,
  httpSend,
  type RequestTimeouts,
} from "../http/mod.ts";
import type { BotConfig } from "./bot_config.ts";
import { configError } from "./errors.ts";

/** Адрес Bot API; параметром — чтобы тест ходил на петлю, а не наружу. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Пределы времени этого вызова — шире умолчания транспорта (3s/10s).
 * Умолчание отмерено на стенд в локальной сети; здесь путь другой:
 * внешний узел, а у большинства операторов ещё и прокси, добавляющий
 * рукопожатие. На умолчании первый же живой вызов упирался в
 * «no response headers within 3000ms», не дойдя до Telegram.
 */
const BOT_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: 15_000,
  totalTimeoutMs: 30_000,
};

/** Ответ об отправке: наружу уходит только номер сообщения. */
export interface BotSent {
  readonly id: number;
}

/** Описания, при которых отказ означает «диалог с ботом не начат». */
const NEEDS_START = ["chat not found", "bot was blocked"];

/** Отправляет текст единственному адресату конфигурации. */
export async function sendBotMessage(
  config: BotConfig,
  text: string,
  apiBase: string = TELEGRAM_API_BASE,
): Promise<BotSent> {
  const url = new URL(`${apiBase}/bot${config.token}/sendMessage`);
  let response;
  try {
    response = await httpSend(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text }),
      timeouts: BOT_TIMEOUTS,
      // Прокси адресный: он нужен пути наружу, а обращения к стенду
      // ходят напрямую (`docs/specs/telegram-log.md`, «Конфигурация»).
      ...(config.proxy === undefined ? {} : { proxy: config.proxy }),
    });
  } catch (err) {
    if (err instanceof HttpCallError) {
      throw configError(
        `bot API недоступен: ${firstLine(err.message)}`,
        { cause: err },
      );
    }
    throw err;
  }
  return parseReply(response.text, config);
}

/** Разбор ответа: успех — номер сообщения, отказ — код и описание. */
function parseReply(text: string, config: BotConfig): BotSent {
  let reply: {
    ok?: boolean;
    error_code?: number;
    description?: string;
    result?: { message_id?: number };
  };
  try {
    reply = JSON.parse(text);
  } catch {
    // Не JSON — это не Bot API на том конце: шлюз, прокси или
    // заглушка. Молча считать успехом нельзя.
    throw configError(`bot API вернул не JSON: ${firstLine(text)}`);
  }
  if (reply.ok !== true) throw configError(failureText(reply, config));
  const id = reply.result?.message_id;
  if (typeof id !== "number") {
    throw configError("bot API не сообщил номер сообщения");
  }
  return { id };
}

/** Текст отказа; у «диалог не начат» — подсказка, что делать. */
function failureText(
  reply: { error_code?: number; description?: string },
  config: BotConfig,
): string {
  const code = reply.error_code ?? 0;
  const description = reply.description ?? "без описания";
  const base = `bot API ${code} ${description}`;
  if (!NEEDS_START.some((marker) => description.includes(marker))) return base;
  // Единственная реальная причина на старте — боту ещё не написали:
  // первым он писать не вправе.
  const name = config.botName === undefined ? "" : ` @${config.botName}`;
  return `${base}; напиши боту${name} /start`;
}
