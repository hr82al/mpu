/**
 * Галерея ответа строки: картинки результатов по порядку и предел суммы
 * их байтов (`platform/picture-frame.md`, «Предел»).
 */

import { Buffer } from "node:buffer";
import type { PictureData, PictureMime } from "../frames/mod.ts";
import type { Picture, Shelf } from "./picture.ts";

/**
 * Предел суммы байтов картинок одного ответа: base64 ≤ 5 000 000 — самый
 * строгий из документированных пределов на изображение ([D.3]).
 */
export const PICTURE_LIMIT = 3_750_000;

/** Картинки одного ответа строки. */
export class Gallery implements Shelf {
  readonly #limit: number;
  readonly #offered: Picture[] = [];
  readonly #taken: PictureData[] = [];
  #sum = 0;

  /** @param limit предел суммы байтов картинок ответа */
  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Картинка результата — в очередь; файл читается в конце строки. */
  offer(picture: Picture) {
    this.#offered.push(picture);
  }

  /**
   * Кадры картинок строки, кончившейся кодом `exit`, по порядку
   * предложения. Код ≠ 0 — ни одного, и файлы не читаются: блок без
   * итога сбил бы агента. Не поместившаяся предел не расходует:
   * следующие, которые ещё помещаются, свои кадры дают.
   */
  async frames(exit: number): Promise<PictureData[]> {
    if (exit !== 0) return [];
    for (const picture of this.#offered.splice(0)) await picture.addTo(this);
    return this.#taken.splice(0);
  }

  fits(size: number): boolean {
    return this.#sum + size <= this.#limit;
  }

  take(mime: PictureMime, bytes: Uint8Array) {
    // Сумма — по прочитанному, а не по размеру до чтения: файл мог
    // вырасти между ними.
    if (!this.fits(bytes.byteLength)) return;
    this.#sum += bytes.byteLength;
    // `Buffer`, а не `Uint8Array#toBase64`: того нет в Node 24.
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString("base64");
    this.#taken.push({ mime, data });
  }
}
