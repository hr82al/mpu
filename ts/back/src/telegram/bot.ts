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
  buildMultipartBody,
  firstLine,
  HttpCallError,
  httpSend,
  type MultipartPart,
  type RequestTimeouts,
} from "../http/mod.ts";
import type { Attachment } from "./attachment.ts";
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

/**
 * Что уходит боту: текст сообщения либо документ с подписью. Развилка
 * выражена типом, а не флагом-параметром: у веток разные методы Bot API,
 * разные тела запроса и разные пределы длины текста, и общего у них
 * ровно адресат.
 */
export type BotMessage =
  | { readonly kind: "text"; readonly text: string }
  | {
    readonly kind: "document";
    /** Подпись документа; пустая — документ уходит без неё. */
    readonly caption: string;
    readonly file: Attachment;
  };

/** Описания, при которых отказ означает «диалог с ботом не начат». */
const NEEDS_START = ["chat not found", "bot was blocked"];

/** Отправляет сообщение единственному адресату конфигурации. */
export async function sendBotMessage(
  config: BotConfig,
  message: BotMessage,
  apiBase: string = TELEGRAM_API_BASE,
): Promise<BotSent> {
  const call = botCall(config.chatId, message);
  const url = new URL(`${apiBase}/bot${config.token}/${call.method}`);
  let response;
  try {
    response = await httpSend(url, {
      method: "POST",
      headers: { "content-type": call.contentType },
      body: call.body,
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

/** Вызов Bot API: метод пути и готовое тело с объявленным типом. */
interface BotCall {
  readonly method: "sendMessage" | "sendDocument";
  readonly contentType: string;
  readonly body: string | Uint8Array<ArrayBuffer>;
}

/**
 * Метод и тело по виду сообщения: текст — JSON на `sendMessage`,
 * документ — `multipart/form-data` на `sendDocument`. Второго сообщения
 * рядом с документом не отправляется: текст уходит его подписью, как у
 * `mpu telegram send` (`docs/specs/telegram-log.md`, «Ввод/вывод»).
 */
function botCall(chatId: number, message: BotMessage): BotCall {
  switch (message.kind) {
    case "text":
      return {
        method: "sendMessage",
        contentType: "application/json",
        body: JSON.stringify({ chat_id: chatId, text: message.text }),
      };
    case "document": {
      // Граница генерируется на запрос — как у Kaiten, второго
      // потребителя того же сборщика (`../http/multipart.ts`).
      const built = buildMultipartBody(
        documentParts(chatId, message.caption, message.file),
        `mpu-${crypto.randomUUID()}`,
      );
      return {
        method: "sendDocument",
        contentType: built.contentType,
        body: built.bytes,
      };
    }
    default: {
      const unknown: never = message;
      throw new TypeError(`неизвестный вид сообщения: ${String(unknown)}`);
    }
  }
}

/** Части формы `sendDocument`: адресат, подпись (если есть) и файл. */
function documentParts(
  chatId: number,
  caption: string,
  file: Attachment,
): readonly MultipartPart[] {
  return [
    { kind: "field", name: "chat_id", value: String(chatId) },
    // Пустой подписи в форме нет вовсе: Bot API отличает отсутствующее
    // поле от пустого, и пустое дало бы документ с пустой подписью.
    ...(caption === ""
      ? []
      : [{ kind: "field", name: "caption", value: caption } as const]),
    {
      kind: "file",
      name: "document",
      // Имя в Telegram — базовое имя пути: путь до файла на машине
      // отправителя адресату не сообщается.
      filename: file.name,
      bytes: file.bytes,
    },
  ];
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
