/**
 * Текст файла метода словами (`image-sync.md`, «Текст → слова»): байты
 * UTF-8, BOM в начале снимается, разделители — ровно пробел, табуляция,
 * перевод строки и возврат каретки. Неразрывный пробел и прочие — часть
 * слова: файл, записанный из базы, читается обратно в те же слова.
 */

/** Байт BOM в начале файла. */
const BOM = [0xef, 0xbb, 0xbf];

/** Разделители слов — ровно четыре, не `\s`. */
const SEPARATORS = /[ \t\n\r]+/;

/** Файл не в UTF-8: причина строкой с первым плохим байтом. */
export class NotUtf8 extends Error {
  override name = "NotUtf8";
}

/**
 * Где начинается первая неверная последовательность UTF-8; всё верно —
 * `-1`. Правила — RFC 3629: без длинных форм и суррогатов.
 */
function firstBadByte(bytes: Uint8Array): number {
  let at = 0;
  while (at < bytes.length) {
    const length = sequenceLength(bytes, at);
    if (length === 0) return at;
    at += length;
  }
  return -1;
}

/** Длина верной последовательности с позиции `at`; неверная — 0. */
function sequenceLength(bytes: Uint8Array, at: number): number {
  const lead = bytes[at];
  if (lead < 0x80) return 1;
  const [length, low, high] = leadRange(lead);
  if (length === 0) return 0;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i];
    const [min, max] = i === 1 ? [low, high] : [0x80, 0xbf];
    if (byte === undefined || byte < min || byte > max) return 0;
  }
  return length;
}

/** Длина последовательности по первому байту и границы второго. */
function leadRange(lead: number): readonly [number, number, number] {
  if (lead >= 0xc2 && lead <= 0xdf) return [2, 0x80, 0xbf];
  if (lead === 0xe0) return [3, 0xa0, 0xbf];
  if (lead === 0xed) return [3, 0x80, 0x9f];
  if (lead >= 0xe1 && lead <= 0xef) return [3, 0x80, 0xbf];
  if (lead === 0xf0) return [4, 0x90, 0xbf];
  if (lead >= 0xf1 && lead <= 0xf3) return [4, 0x80, 0xbf];
  if (lead === 0xf4) return [4, 0x80, 0x8f];
  return [0, 0, 0];
}

/** Шестнадцатеричная запись байта: `0xC3`. */
function hex(byte: number): string {
  return `0x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Слова текста файла метода.
 *
 * @throws NotUtf8 — байты не в UTF-8
 */
export function fileWords(bytes: Uint8Array): string[] {
  const bad = firstBadByte(bytes);
  if (bad >= 0) {
    throw new NotUtf8(
      `файл не в UTF-8: байт ${hex(bytes[bad])} на смещении ${bad}`,
    );
  }
  const start = BOM.every((byte, i) => bytes[i] === byte) ? BOM.length : 0;
  const text = new TextDecoder().decode(bytes.subarray(start));
  return text.split(SEPARATORS).filter((word) => word !== "");
}
