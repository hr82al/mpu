/**
 * Картинка результата команды (`platform/picture-frame.md` [D.5]):
 * результат не несёт байтов — они ушли бы в `it`, журнал и
 * `structuredContent`, — а называет файл, который станет картинкой,
 * если его байты ею окажутся.
 */

import { readFile, stat } from "node:fs/promises";
import { kindOf, type Taker } from "./kind.ts";

/** Куда картинка кладёт себя: место под предел и приём байтов. */
export interface Shelf extends Taker {
  /** Поместится ли картинка `size` байт к уже взятым. */
  fits(size: number): boolean;
}

/** Картинка результата: кладёт себя на полку, если может. */
export interface Picture {
  addTo(shelf: Shelf): Promise<void>;
}

/** Картинки нет — ответ всех результатов, не объявивших её. */
export const NO_PICTURE: Picture = { addTo: () => Promise.resolve() };

/** Файл, записанный командой: картинка, если байты ею окажутся. */
class FilePicture implements Picture {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async addTo(shelf: Shelf) {
    let bytes: Uint8Array;
    try {
      // Размер — до чтения: вложение не ограничено, и файл за пределом
      // читать целиком незачем.
      if (!shelf.fits((await stat(this.#path)).size)) return;
      bytes = new Uint8Array(await readFile(this.#path));
    } catch {
      // Картинка — дополнение к ответу: файл, который к концу строки не
      // прочитать (удалён, нет прав, не файл), её не даёт, а итог строки
      // не меняет («Контракт»). Здесь только чтение файла по пути —
      // других отказов, кроме файловой системы, у него нет.
      return;
    }
    kindOf(bytes).offer(bytes, shelf);
  }
}

/** Картинка из файла `path`, записанного командой. */
export function filePicture(path: string): Picture {
  return new FilePicture(path);
}
