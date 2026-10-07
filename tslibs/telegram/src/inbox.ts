/**
 * Каталог, куда кладутся скачанные вложения (`telegram-file.md`,
 * «Ввод/вывод» и [D.4]); какой это каталог, решает потребитель.
 *
 * По пути файла лежит только целиком скачанное вложение: байты идут во
 * временный файл того же каталога и переименовываются после конца
 * потока, а при отказе временный файл удаляется — прежний файл по пути
 * остаётся как был.
 */

import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import { configError } from "./errors.ts";

/** Записанный файл и число записанных в него байт. */
export interface Kept {
  readonly path: string;
  readonly size: number;
}

/** Каталог-получатель вложений. */
export class Inbox {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * Записывает поток байт в файл `name` каталога. Отказ файловой системы —
   * строкой слоя с путём; отказ самого потока (сеть) — как есть: его
   * оформил порт сеанса.
   */
  async keep(name: string, bytes: AsyncIterable<Uint8Array>): Promise<Kept> {
    const path = `${this.#dir}/${name}`;
    // Каталог есть — используется как есть: права чужого каталога не
    // правятся. `mode` режет umask, но 0700 он только сужает.
    await writing(path, () =>
      mkdir(this.#dir, { recursive: true, mode: 0o700 }),
    );
    // Временное имя не содержит имени вложения: длинное имя плюс суффикс
    // упёрлось бы в предел длины имени файла раньше самого файла.
    const temp = `${this.#dir}/.part-${crypto.randomUUID()}`;
    try {
      const size = await pour(temp, path, bytes);
      await writing(path, () => rename(temp, path));
      return { path, size };
    } catch (err) {
      // Временного файла может уже не быть (не создан), а отказ его
      // удаления не важнее того, из-за которого удаляем.
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

/** Переливает поток в новый файл; возвращает число записанных байт. */
async function pour(
  temp: string,
  path: string,
  bytes: AsyncIterable<Uint8Array>,
): Promise<number> {
  // `wx` — только новый файл: временное имя чужим быть не должно.
  const file = await writing(path, () => open(temp, "wx", 0o600));
  let size = 0;
  try {
    for await (const chunk of bytes) {
      // Величина — из записанного, а не из заявки Telegram ([D.3]).
      size += await writing(path, () => writeAll(file, chunk));
    }
  } catch (err) {
    // Прерывание закрывает файл; его собственный отказ не важнее того,
    // из-за которого прерываем.
    await file.close().catch(() => {});
    throw err;
  }
  await writing(path, () => file.close());
  return size;
}

/**
 * Пишет кусок целиком; возвращает число записанных байт. `write` не
 * обещает записать всё за раз — недописанный хвост дописывается.
 */
async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<number> {
  let written = 0;
  while (written < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, written);
    written += bytesWritten;
  }
  return written;
}

/** Операция файловой системы: её отказ — строкой слоя с путём файла. */
async function writing<T>(path: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw configError(`не удалось записать ${path}: ${reason}`, { cause: err });
  }
}
