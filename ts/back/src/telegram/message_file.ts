/**
 * Вложение входящего сообщения (`docs/specs/telegram-file.md`, таблица
 * «Ввод/вывод»): описание для выдачи поиска и скачивание в каталог.
 *
 * Правило «вид вложения → имя и тип» одно для `telegram file` и для поля
 * `file` выдачи `telegram search`, поэтому живёт здесь, а не у команд.
 * Модуль не знает клиента Telegram: ответ клиента к этим объектам
 * приводит `media_file.ts`, и грузится он только вместе с сеансом.
 */

import { configError } from "./errors.ts";
import type { Inbox } from "./inbox.ts";

/** Поле `file` выдачи поиска: размер — заявленный Telegram. */
export interface ListedFile {
  readonly name: string;
  readonly size: number;
  /** MIME-тип; отправитель его не задал — `null`. */
  readonly mime: string | null;
}

/** Вывод `telegram file`: ключи и их порядок — контракт. */
export interface SavedFile {
  /** Абсолютный путь записанного файла. */
  readonly path: string;
  /** Имя вложения до замены `/` и NUL. */
  readonly name: string;
  /** Байты, записанные в файл, — не заявка Telegram ([D.3]). */
  readonly size: number;
  readonly mime: string | null;
}

/** Вложение сообщения: есть оно или нет, отвечает само. */
export interface MessageFile {
  /** Поле `file` выдачи поиска; вложения нет — `null` (контракт JSON). */
  listed(): ListedFile | null;
  /** Скачивает вложение в каталог; вложения нет — отказ слоя. */
  saveTo(inbox: Inbox, chatId: number): Promise<SavedFile>;
}

/** Байты вложения по мере скачивания; отказ сети — уже строкой слоя. */
export type FileBytes = () => AsyncIterable<Uint8Array>;

/** Вложение, которое есть: описание плюс источник байтов. */
class AttachedFile implements MessageFile {
  readonly #messageId: number;
  readonly #listed: ListedFile;
  readonly #bytes: FileBytes;

  constructor(messageId: number, listed: ListedFile, bytes: FileBytes) {
    this.#messageId = messageId;
    this.#listed = listed;
    this.#bytes = bytes;
  }

  listed(): ListedFile {
    return { ...this.#listed };
  }

  async saveTo(inbox: Inbox, chatId: number): Promise<SavedFile> {
    const { name, mime } = this.#listed;
    const kept = await inbox.keep(
      `${chatId}-${this.#messageId}-${onDisk(name)}`,
      this.#bytes(),
    );
    return { path: kept.path, name, size: kept.size, mime };
  }
}

/**
 * Вложения нет: на описание отвечает `null`, на скачивание — отказом.
 * Нет файла в сообщении и нет самого сообщения — один объект: отвечают
 * они одинаково и различаются только текстом.
 */
class Absent implements MessageFile {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  listed(): null {
    return null;
  }

  saveTo(): Promise<SavedFile> {
    return Promise.reject(configError(this.#reason));
  }
}

/** Документ (и голосовое, стикер, видео): имени нет — `file-<id>`. */
export function documentFile(
  messageId: number,
  described: {
    readonly name: string | null;
    readonly size: number;
    readonly mime: string;
  },
  bytes: FileBytes,
): MessageFile {
  return new AttachedFile(messageId, {
    // Пустое имя — то же «имени нет», что и его отсутствие: иначе путь
    // кончался бы префиксом, а в выводе стояло бы пустое имя.
    name: described.name === null || described.name === ""
      ? `file-${messageId}`
      : described.name,
    size: described.size,
    // Пустой тип — «отправитель не задал», а не тип с пустым именем.
    mime: described.mime === "" ? null : described.mime,
  }, bytes);
}

/** Фото: имени у него не бывает, тип задаёт команда. */
export function photoFile(
  messageId: number,
  size: number,
  bytes: FileBytes,
): MessageFile {
  return new AttachedFile(messageId, {
    name: `photo-${messageId}.jpg`,
    size,
    mime: "image/jpeg",
  }, bytes);
}

/** Сообщение без вложения: текст, превью ссылки, геоточка, служебное. */
export function noFile(messageId: number): MessageFile {
  return new Absent(`в сообщении ${messageId} нет файла`);
}

/** Сообщения нет: не было или удалено. */
export function noMessage(messageId: number): MessageFile {
  return new Absent(`сообщение ${messageId} не найдено`);
}

/**
 * Имя на диске ([D.2]): `/` и NUL — на `_`, иначе имя вложения уводит
 * запись из каталога; прочее остаётся как есть.
 */
function onDisk(name: string): string {
  return name.replaceAll(/[/\0]/g, "_");
}
