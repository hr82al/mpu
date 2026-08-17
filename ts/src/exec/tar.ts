/**
 * Архив tar из одного файла — ровно то, что принимает
 * `PUT /containers/<имя>/archive` при доставке stdin в контейнер
 * (`platform/exec-transport.md`, п. 2).
 *
 * Свои 40 строк вместо зависимости: нужен один формат записи (ustar,
 * обычный файл, без каталогов и ссылок), а чтения не нужно вовсе.
 */

/** Размер блока tar; и заголовок, и хвост кратны ему. */
const BLOCK = 512;

/** Смещения полей заголовка ustar. */
const FIELD = {
  name: 0,
  mode: 100,
  uid: 108,
  gid: 116,
  size: 124,
  mtime: 136,
  checksum: 148,
  type: 156,
  magic: 257,
} as const;

/**
 * Архив с единственным файлом. `mtime` — параметр, а не «сейчас»: одна
 * и та же пара (имя, содержимое) обязана давать одинаковые байты, иначе
 * сравнивать архив в тесте не с чем.
 */
export function tarFile(
  name: string,
  content: Uint8Array,
  options: { readonly mode?: number; readonly mtime?: number } = {},
): Uint8Array<ArrayBuffer> {
  const padded = Math.ceil(content.length / BLOCK) * BLOCK;
  // Конец архива — два нулевых блока (POSIX).
  const out = new Uint8Array(BLOCK + padded + BLOCK * 2);
  const header = out.subarray(0, BLOCK);
  const encoder = new TextEncoder();

  header.set(encoder.encode(name), FIELD.name);
  header.set(encoder.encode(octal(options.mode ?? 0o644, 7)), FIELD.mode);
  header.set(encoder.encode(octal(0, 7)), FIELD.uid);
  header.set(encoder.encode(octal(0, 7)), FIELD.gid);
  header.set(encoder.encode(octal(content.length, 11)), FIELD.size);
  header.set(encoder.encode(octal(options.mtime ?? 0, 11)), FIELD.mtime);
  header[FIELD.type] = "0".charCodeAt(0);
  header.set(encoder.encode("ustar\0" + "00"), FIELD.magic);

  // Контрольная сумма считается так, будто её поле забито пробелами.
  header.fill(0x20, FIELD.checksum, FIELD.checksum + 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(`${octal(sum, 6)}\0 `), FIELD.checksum);

  out.set(content, BLOCK);
  return out;
}

/** Число восьмеричной строкой фиксированной ширины с ведущими нулями. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}
