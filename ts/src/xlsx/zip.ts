/**
 * Минимальный ридер zip-архива под нужды .xlsx: читает central
 * directory, распаковывает все записи в память (книга по контракту
 * спеки разбирается целиком). Поддержаны методы stored (0) и deflate
 * (8, через встроенный `DecompressionStream`) — другие в OOXML не
 * встречаются. Зависимость на полноценную zip-библиотеку не оправдана:
 * нужен только словарь «имя → байты».
 */

/** Ошибка формата архива; текст попадает в «not a valid xlsx file: … (…)». */
export class ZipError extends Error {
  override name = "ZipError";
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Размер EOCD без комментария. */
const EOCD_MIN = 22;
/** Максимальная длина комментария архива — поле в 2 байта. */
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

const utf8 = new TextDecoder();

/**
 * Распаковывает архив в словарь «имя записи → содержимое».
 * Порядок ключей — порядок записей в central directory.
 */
export async function unzip(
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(bytes, view);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === ZIP64_MARKER) {
    throw new ZipError("zip64 archives are not supported");
  }

  const files = new Map<string, Uint8Array>();
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== CENTRAL_SIG) {
      throw new ZipError("truncated central directory");
    }
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new ZipError("zip64 archives are not supported");
    }
    if (pos + 46 + nameLength > bytes.length) {
      throw new ZipError("truncated central directory");
    }
    const name = utf8.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    files.set(
      name,
      await readEntry(bytes, view, name, method, localOffset, compressedSize),
    );
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Ищет EOCD с конца файла (комментарий архива сдвигает его вглубь). */
function findEocd(bytes: Uint8Array, view: DataView): number {
  const from = bytes.length - EOCD_MIN;
  const to = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  for (let pos = from; pos >= to; pos--) {
    if (view.getUint32(pos, true) !== EOCD_SIG) continue;
    // Сигнатура могла встретиться в байтах комментария: настоящий
    // EOCD закрывает файл своим полем длины комментария.
    const commentLength = view.getUint16(pos + 20, true);
    if (pos + EOCD_MIN + commentLength === bytes.length) return pos;
  }
  throw new ZipError("not a zip archive");
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  name: string,
  method: number,
  localOffset: number,
  compressedSize: number,
): Promise<Uint8Array> {
  if (
    localOffset + 30 > bytes.length ||
    view.getUint32(localOffset, true) !== LOCAL_SIG
  ) {
    throw new ZipError(`corrupt local header of "${name}"`);
  }
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  if (start + compressedSize > bytes.length) {
    throw new ZipError(`truncated entry "${name}"`);
  }
  const compressed = bytes.subarray(start, start + compressedSize);
  switch (method) {
    case 0:
      return compressed.slice();
    case 8:
      try {
        return await inflateRaw(compressed);
      } catch (err) {
        throw new ZipError(`corrupt deflate stream in "${name}"`, {
          cause: err,
        });
      }
    default:
      throw new ZipError(`unsupported compression method ${method}`);
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
