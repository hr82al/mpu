/**
 * Клиент MTProto глазами команд — узкий интерфейс потребителя
 * (`docs/specs/platform/telegram-mtproto.md`). Всё, что знает про
 * протокол, лежит в `session.ts`; здесь только форма обмена, поэтому
 * поведение команд проверяется фейком, без сети.
 */

import type { Peer } from "./peer.ts";

/** Файл, уходящий документом без превью; несколько — альбом. */
export interface Attachment {
  /** Имя файла в Telegram: файлы уходят под своими именами. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Вложение, уходящее в Telegram: подпись несёт не каждое. */
export interface OutgoingDocument extends Attachment {
  /** Подпись; её несёт последнее вложение, и только при непустом тексте. */
  readonly caption?: string;
}

/** Адресат, уже опознанный клиентом: содержимое ссылки — дело клиента. */
export interface PeerRef {
  readonly ref: unknown;
}

/** Сообщение, как о нём отчитался клиент. */
export interface ClientMessage {
  readonly id: number;
  /** Чат, куда легло сообщение; Telegram не сообщил — `null`. */
  readonly chatId: number | null;
  /** Время по данным Telegram; не сообщено — `null`. */
  readonly date: Date | null;
}

/**
 * Сеанс приходит в команду уже открытым и знающим собственную учётную
 * запись — без этого адресат `me` не резолвится, а авторизация обязана
 * проверяться до операции (там же, «Инварианты»).
 */
export interface TelegramClient {
  readonly resolve: (peer: Peer) => Promise<PeerRef>;
  readonly sendText: (
    to: PeerRef,
    text: string,
    markdown: boolean,
  ) => Promise<ClientMessage>;
  /** Альбом одним вызовом: сообщений столько же, сколько вложений. */
  readonly sendDocuments: (
    to: PeerRef,
    documents: readonly OutgoingDocument[],
    markdown: boolean,
  ) => Promise<readonly ClientMessage[]>;
}
