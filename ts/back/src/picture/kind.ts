/**
 * Вид картинки по первым байтам файла (`platform/picture-frame.md`,
 * «Вид картинки — по байтам»): блок, который Claude не разберёт, ломает
 * разговор агента, поэтому вид решают байты, а не `mime`, присланный
 * источником файла.
 */

import type { PictureMime } from "../frames/mod.ts";

/** Куда вид кладёт байты картинки. */
export interface Taker {
  take(mime: PictureMime, bytes: Uint8Array): void;
}

/** Вид байтов: картинка отдаёт себя получателю, не картинка — ничего. */
export interface Kind {
  offer(bytes: Uint8Array, taker: Taker): void;
}

/** Часть подписи: байты `bytes` со смещения `at`. */
interface Part {
  readonly at: number;
  readonly bytes: Uint8Array;
}

/** Подпись формата: все её части на своих местах. */
class Signature implements Kind {
  readonly #mime: PictureMime;
  readonly #parts: readonly Part[];

  constructor(mime: PictureMime, parts: readonly Part[]) {
    this.#mime = mime;
    this.#parts = parts;
  }

  matches(bytes: Uint8Array): boolean {
    return this.#parts.every(
      ({ at, bytes: part }) =>
        bytes.byteLength >= at + part.byteLength &&
        part.every((byte, i) => bytes[at + i] === byte),
    );
  }

  offer(bytes: Uint8Array, taker: Taker) {
    taker.take(this.#mime, bytes);
  }
}

function part(at: number, ...bytes: readonly (number | string)[]): Part {
  const flat = bytes.flatMap((one) =>
    typeof one === "number" ? [one] : [...new TextEncoder().encode(one)],
  );
  return { at, bytes: new Uint8Array(flat) };
}

const SIGNATURES: readonly Signature[] = [
  new Signature("image/jpeg", [part(0, 0xff, 0xd8, 0xff)]),
  new Signature("image/png", [part(0, 0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)]),
  new Signature("image/gif", [part(0, "GIF87a")]),
  new Signature("image/gif", [part(0, "GIF89a")]),
  new Signature("image/webp", [part(0, "RIFF"), part(8, "WEBP")]),
];

/** Не картинка: получателю ничего. */
const NOT_A_PICTURE: Kind = { offer() {} };

/** Вид файла по его байтам; ни одна подпись не подошла — не картинка. */
export function kindOf(bytes: Uint8Array): Kind {
  return SIGNATURES.find((one) => one.matches(bytes)) ?? NOT_A_PICTURE;
}
