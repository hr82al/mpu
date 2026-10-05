/**
 * Стенд сценариев `platform/picture-frame.md` (P1–P20): сообщения чата
 * `-1000000000101` с литералами байтов спеки и исполнение
 * `telegram file` настоящим кодом команды — подменён только сеанс
 * Telegram, файлы ложатся во временный каталог теста.
 */

import type { CommandIo } from "../command/mod.ts";
import { VerbatimError } from "../command/mod.ts";
import type { PeerRef } from "./client.ts";
import { type FileSession, runTelegramFile } from "./cmd_file.ts";
import { INBOX_DIR } from "./inbox.ts";
import {
  documentFile,
  type MessageFile,
  noFile,
  noMessage,
  photoFile,
  type SavedFile,
} from "./message_file.ts";
import type { ResolvablePeer } from "./peer.ts";

/** Чат сценариев. */
export const PICTURE_CHAT = "-1000000000101";

const ascii = (text: string) => [...new TextEncoder().encode(text)];

/** Литералы байтов спеки. */
export const BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46],
  png: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00],
  gif: [...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00],
  webp: [...ascii("RIFF"), 0x0C, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 ")],
  svg: ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  text: ascii("# не картинка"),
} as const;

/** `size` байт, начинающихся байтами JPEG (P11–P14). */
function jpegOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(BYTES.jpeg);
  return bytes;
}

function body(bytes: Uint8Array | readonly number[]) {
  const all = Uint8Array.from(bytes);
  return async function* () {
    await Promise.resolve();
    yield all;
  };
}

function doc(
  id: number,
  name: string,
  mime: string,
  bytes: readonly number[],
): [number, MessageFile] {
  return [
    id,
    documentFile(id, { name, size: bytes.length, mime }, body(bytes)),
  ];
}

function photo(id: number, bytes: Uint8Array): [number, MessageFile] {
  return [id, photoFile(id, bytes.byteLength, body(bytes))];
}

/** Сообщения сценариев: id → вложение. */
function messages(): ReadonlyMap<number, MessageFile> {
  return new Map([
    photo(43, Uint8Array.from(BYTES.jpeg)),
    doc(42, "разбор.md", "text/markdown", ascii("#".repeat(1234))),
    [45, noFile(45)],
    doc(50, "схема.png", "image/png", BYTES.png),
    doc(51, "a.gif", "image/gif", BYTES.gif),
    doc(52, "b.webp", "image/webp", BYTES.webp),
    doc(53, "logo.svg", "image/svg+xml", BYTES.svg),
    doc(54, "скрин.png", "image/png", BYTES.text),
    doc(55, "scan.bin", "application/octet-stream", BYTES.jpeg),
    photo(56, jpegOf(3_750_000)),
    photo(57, jpegOf(3_750_001)),
  ]);
}

/** Сеанс стенда: чат по id, сообщения сценариев; 46 — нет (F8). */
class StandSession implements FileSession {
  readonly #files = messages();

  resolve(peer: ResolvablePeer): Promise<PeerRef> {
    if (peer.kind === "id") return Promise.resolve({ ref: peer, id: peer.id });
    return Promise.reject(new VerbatimError("telegram: чат не на стенде"));
  }

  searchChats(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }

  messageFile(_chat: PeerRef, id: number): Promise<MessageFile> {
    return Promise.resolve(this.#files.get(id) ?? noMessage(id));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Исполнение `telegram file` на стенде: разобранные аргументы команды →
 * файл в каталоге `dir`.
 */
export function savedOnStand(
  args: Readonly<Record<string, unknown>>,
  io: CommandIo,
  dir: string,
): Promise<SavedFile> {
  return runTelegramFile(
    { chat: String(args.chat), id: String(args.id) },
    io,
    { openSession: () => Promise.resolve(new StandSession()), dir },
  );
}

/** Текст стенда глазами спеки: временный каталог — `/tmp/mpu-telegram`. */
export function asInbox(text: string, dir: string): string {
  return text.replaceAll(dir, INBOX_DIR);
}
