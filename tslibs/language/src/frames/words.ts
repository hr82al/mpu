/**
 * Текст словами: байты UTF-8, BOM в начале снимается, разделители —
 * ровно пробел, табуляция, перевод строки и возврат каретки. Неразрывный
 * пробел и прочие — часть слова.
 *
 * Правило лежит в контракте кадров, потому что у него две стороны: ввод
 * строки без слов проверяет тонкий клиент (UTF-8), а слова в нём находит
 * ядро — это прежняя форма (`platform/stage6-l1.md`).
 */

/** BOM, прочитанный как текст. */
const BOM_CHAR = "\ufeff";

/** Разделители слов — ровно четыре, не `\s`. */
const SEPARATORS = /[ \t\n\r]+/;

/** Есть ли в слове хоть один разделитель. */
const SEPARATOR = /[ \t\n\r]/;

/** Слово входа двери (`platform/ask-door.md`): первое слово строки, не команда. */
export const ASK_WORD = "ask";

/**
 * Байты не в UTF-8: первый байт неверной последовательности и его
 * смещение. Текст — без существительного: «файл» или «ввод» добавляет тот,
 * кто читал.
 */
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
 * Текст байтов UTF-8; BOM в начале остаётся — его снимает `wordsOf`, одна
 * на всех читающих.
 *
 * @throws NotUtf8 — байты не в UTF-8; смещение — от первого байта, BOM
 *   включён
 */
export function utf8Of(bytes: Uint8Array): string {
  const bad = firstBadByte(bytes);
  if (bad >= 0) {
    throw new NotUtf8(`не в UTF-8: байт ${hex(bytes[bad])} на смещении ${bad}`);
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** Слова текста: BOM в начале снят, пустых слов нет. */
export function wordsOf(text: string): string[] {
  const start = text.startsWith(BOM_CHAR) ? BOM_CHAR.length : 0;
  return text
    .slice(start)
    .split(SEPARATORS)
    .filter((word) => word !== "");
}

/**
 * Есть ли в слове разделитель: такое слово пришло целым (элемент MCP,
 * кавычки оболочки), его `^` текст не открывает (`at-word-literal.md`,
 * правило 1).
 */
export function hasSeparator(word: string): boolean {
  return SEPARATOR.test(word);
}

/**
 * Строка без слов — пусто или одно `ask`: при вводе из пайпа программа —
 * сам ввод (`stdin-on-request.md`, «Строка без слов»).
 */
export function isBareLine(words: readonly string[]): boolean {
  if (words.length === 0) return true;
  return words.length === 1 && words[0] === ASK_WORD;
}
