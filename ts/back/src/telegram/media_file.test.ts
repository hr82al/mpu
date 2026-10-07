/**
 * Медиа mtcute → вложение. Сообщения строятся настоящим `Message` клиента
 * из сырых TL-объектов: вид медиа выбирает сам клиент (`message.media`),
 * так что тест закрепляет догадку о его ответе ровно там, где её читает
 * команда. Форма живьём не снята (`telegram-file.md`, «Golden-примеры»).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Long, Message, PeersIndex, type tl } from "@mtcute/node";
import { Inbox } from "./inbox.ts";
import { mediaFile } from "./media_file.ts";

function message(id: number, media?: tl.TypeMessageMedia): Message {
  return new Message({
    _: "message",
    id,
    peerId: { _: "peerChannel", channelId: 101 },
    date: 1_790_000_000,
    message: "Отписал по спеке",
    ...(media === undefined ? {} : { media }),
  }, new PeersIndex());
}

function document(
  size: number,
  mimeType: string,
  attributes: tl.TypeDocumentAttribute[],
): tl.TypeMessageMedia {
  return {
    _: "messageMediaDocument",
    document: {
      _: "document",
      id: Long.fromNumber(1),
      accessHash: Long.fromNumber(2),
      fileReference: new Uint8Array(),
      date: 1_790_000_000,
      mimeType,
      size,
      dcId: 2,
      attributes,
    },
  };
}

const PHOTO: tl.TypeMessageMedia = {
  _: "messageMediaPhoto",
  photo: {
    _: "photo",
    id: Long.fromNumber(3),
    accessHash: Long.fromNumber(4),
    fileReference: new Uint8Array(),
    date: 1_790_000_000,
    sizes: [
      { _: "photoSize", type: "m", w: 320, h: 240, size: 512 },
      { _: "photoSize", type: "y", w: 1280, h: 960, size: 2048 },
    ],
    dcId: 2,
  },
};

const WEBPAGE: tl.TypeMessageMedia = {
  _: "messageMediaWebPage",
  webpage: { _: "webPageEmpty", id: Long.fromNumber(5) },
};

const GEO: tl.TypeMessageMedia = {
  _: "messageMediaGeo",
  geo: { _: "geoPoint", long: 37.6, lat: 55.7, accessHash: Long.ZERO },
};

const nowhere = () => {
  throw new Error("скачивание не ожидается");
};

describe("вид медиа клиента → описание вложения", () => {
  const cases = [
    {
      name: "документ с именем (F1)",
      message: message(
        42,
        document(1234, "text/markdown", [
          { _: "documentAttributeFilename", fileName: "разбор.md" },
        ]),
      ),
      listed: { name: "разбор.md", size: 1234, mime: "text/markdown" },
    },
    {
      name: "голосовое без имени (F9)",
      message: message(
        48,
        document(300, "audio/ogg", [
          { _: "documentAttributeAudio", voice: true, duration: 3 },
        ]),
      ),
      listed: { name: "file-48", size: 300, mime: "audio/ogg" },
    },
    {
      name: "фото — наибольший размер (F4)",
      message: message(43, PHOTO),
      listed: { name: "photo-43.jpg", size: 2048, mime: "image/jpeg" },
    },
    { name: "текст (F6)", message: message(45), listed: null },
    { name: "превью ссылки (F7)", message: message(47, WEBPAGE), listed: null },
    { name: "геоточка", message: message(50, GEO), listed: null },
  ];
  for (const { name, message, listed } of cases) {
    it(name, () => {
      expect(mediaFile(message.id, message.media, nowhere).listed())
        .toStrictEqual(listed);
    });
  }
});

it("байты вложения просит у клиента по самому медиа", async () => {
  const dir = await mkdtemp(join(tmpdir(), "media-file-"));
  try {
    const found = message(
      42,
      document(4, "text/markdown", [
        { _: "documentAttributeFilename", fileName: "a.md" },
      ]),
    );
    const asked: unknown[] = [];
    const file = mediaFile(found.id, found.media, async function* (location) {
      asked.push(location);
      await Promise.resolve();
      yield new TextEncoder().encode("тело");
    });
    const saved = await file.saveTo(new Inbox(dir), -1000000000101);
    expect(asked).toStrictEqual([found.media]);
    expect(await readFile(saved.path, "utf8")).toStrictEqual("тело");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
