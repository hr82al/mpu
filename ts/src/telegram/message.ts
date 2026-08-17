/**
 * Найденное сообщение (`docs/specs/telegram-search.md`, «Ввод/вывод»):
 * приведение ответа клиента к строке выдачи.
 *
 * Клиент отдаёт чат и отправителя сырыми — теми же `RawChat`, что и
 * поиск чатов. Маркировка идентификатора и ссылка на сообщение строятся
 * здесь: обещание «напечатанный `chat_id` годится как `--chat`» даёт
 * команда, а не протокол.
 */

import { markedId, type RawChat } from "./chat.ts";

/** Сообщение, как о нём отчитался клиент: идентификаторы ещё сырые. */
export interface RawMessage {
  /** Идентификатор сообщения внутри его чата. */
  readonly id: number;
  readonly chat: RawChat;
  /** Отправитель; Telegram его не отдал (анонимный админ) — `null`. */
  readonly sender: RawChat | null;
  /** Время отправки; Telegram не сообщил — `null`. */
  readonly date: Date | null;
  /** Текст сообщения либо подпись вложения; ни того ни другого — пусто. */
  readonly text: string;
}

/** Строка выдачи `telegram search` (`FoundMessage` глоссария). */
export interface FoundMessage {
  readonly id: number;
  /** Маркированный id чата: годится как `--chat` без правки. */
  readonly chat_id: number;
  /** Название чата; не пришло — пустая строка. */
  readonly chat_title: string;
  /** Отображаемое имя отправителя; его нет — `null`. */
  readonly sender: string | null;
  /** Время отправки в UTC, ISO-8601 без долей секунды; нет — `null`. */
  readonly date: string | null;
  readonly text: string;
  /** Ссылка на сообщение; у чата без публикаций — `null`. */
  readonly link: string | null;
}

/** Строка выдачи из ответа клиента. */
export function foundMessage(raw: RawMessage): FoundMessage {
  return {
    id: raw.id,
    chat_id: markedId(raw.chat.peerType, raw.chat.rawId),
    chat_title: raw.chat.title,
    sender: raw.sender === null ? null : raw.sender.title,
    date: raw.date === null ? null : isoUtc(raw.date),
    text: raw.text,
    link: link(raw.chat, raw.id),
  };
}

/**
 * Отправитель маркированным id — им клиентский фильтр `--from` сличает
 * сообщение с адресатом (там же, «Ввод/вывод», глобальный режим).
 * Отправителя нет — `null`, и такое сообщение не совпадает ни с кем.
 */
export function senderId(raw: RawMessage): number | null {
  const sender = raw.sender;
  return sender === null ? null : markedId(sender.peerType, sender.rawId);
}

/**
 * Ссылка на сообщение: она есть только у супергруппы и канала — с
 * именем по имени, без имени по сырому идентификатору. У пользователя,
 * бота и базовой группы публикаций нет, и ссылка на них ведёт не на
 * сообщение (там же, «Известные отклонения», вердикт fix).
 */
function link(chat: RawChat, id: number): string | null {
  if (chat.peerType !== "supergroup" && chat.peerType !== "channel") {
    return null;
  }
  if (chat.username === null) return `https://t.me/c/${chat.rawId}/${id}`;
  return `https://t.me/${chat.username}/${id}`;
}

/** Время до секунд в UTC: `2026-08-16T07:54:28+00:00`. */
function isoUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}
