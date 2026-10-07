/**
 * Медиа сообщения mtcute → вложение команды (`message_file.ts`).
 *
 * Единственное место, читающее форму ответа клиента о вложении: вид
 * медиа, имя, тип и размер. Форма взята из исходников `@mtcute/core`
 * 0.31.0, живьём ещё не снята (`telegram-file.md`, «Golden-примеры»), —
 * расхождение на живом прогоне правится здесь. Грузится только из
 * `session.ts`: классы mtcute тянут клиент, а старт `mpu` за него не
 * платит.
 */

import {
  type FileLocation,
  type MessageMedia,
  Photo,
  RawDocument,
} from "@mtcute/node";
import {
  documentFile,
  type MessageFile,
  noFile,
  photoFile,
} from "./message_file.ts";

/** Скачивание у клиента: байты файла по его расположению. */
export type Download = (location: FileLocation) => AsyncIterable<Uint8Array>;

/**
 * Вложение сообщения по его медиа. Проверка вида — разбор чужого union
 * на границе: документ (с ним голосовое, видео, стикер, аудио — все
 * наследники `RawDocument`) и фото несут файл; превью ссылки, геоточка,
 * опрос и прочее — нет.
 */
export function mediaFile(
  messageId: number,
  media: MessageMedia,
  download: Download,
): MessageFile {
  if (media instanceof RawDocument) {
    return documentFile(messageId, {
      name: media.fileName,
      size: media.raw.size,
      mime: media.mimeType,
    }, () => download(media));
  }
  // Размер фото клиент выбирает сам — наибольший. Поле объявлено
  // необязательным у общего предка `FileLocation`, а конструктор `Photo`
  // без размеров отказывает; 0 — размер, о котором клиент не сообщил,
  // и только в выдаче поиска: при скачивании `size` — записанные байты.
  if (media instanceof Photo) {
    return photoFile(messageId, media.fileSize ?? 0, () => download(media));
  }
  return noFile(messageId);
}
