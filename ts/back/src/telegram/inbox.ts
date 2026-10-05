/**
 * Каталог, куда `mpu telegram file` кладёт вложения
 * (`docs/specs/telegram-file.md`, «Ввод/вывод» и [D.4]).
 *
 * По пути файла лежит только целиком скачанное вложение: байты идут во
 * временный файл того же каталога и переименовываются после конца
 * потока, а при отказе временный файл удаляется — прежний файл по пути
 * остаётся как был.
 */

import { configError } from "./errors.ts";

/** Каталог по умолчанию: `/tmp` уже в праве записи у CLI и сервера. */
export const INBOX_DIR = "/tmp/mpu-telegram";

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
    await writing(
      path,
      () => Deno.mkdir(this.#dir, { recursive: true, mode: 0o700 }),
    );
    // Временное имя не содержит имени вложения: длинное имя плюс суффикс
    // упёрлось бы в предел длины имени файла раньше самого файла.
    const temp = `${this.#dir}/.part-${crypto.randomUUID()}`;
    try {
      const size = await pour(temp, path, bytes);
      await writing(path, () => Deno.rename(temp, path));
      return { path, size };
    } catch (err) {
      // Временного файла может уже не быть (не создан), а отказ его
      // удаления не важнее того, из-за которого удаляем.
      await Deno.remove(temp).catch(() => {});
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
  const file = await writing(
    path,
    () => Deno.open(temp, { write: true, createNew: true, mode: 0o600 }),
  );
  const writer = file.writable.getWriter();
  let size = 0;
  try {
    for await (const chunk of bytes) {
      await writing(path, () => writer.write(chunk));
      // Величина — из записанного, а не из заявки Telegram ([D.3]).
      size += chunk.byteLength;
    }
  } catch (err) {
    // Прерывание закрывает файл; его собственный отказ не важнее того,
    // из-за которого прерываем.
    await writer.abort(err).catch(() => {});
    throw err;
  }
  await writing(path, () => writer.close());
  return size;
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
