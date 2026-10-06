/**
 * Кадры канала Claude Code ↔ ядро (`claude-channel.md`, «Регистрация в
 * ядре»): канал регистрируется ключом сессии, ядро шлёт ему текст
 * владельца, канал отвечает, доставил ли. У кадров две стороны — клиент
 * (`cli/`) и ядро, — поэтому форма одна и лежит в контракте кадров.
 * Кадр — строка JSON в одном сообщении WebSocket.
 */

/** Путь регистрации канала на сервере ядра. */
export const CHANNEL_PATH = "/channel";

/** Поля объекта JSON; не объект — `undefined`. */
function fieldsOf(text: string): Readonly<Record<string, unknown>> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  // Сужение до объекта сделано проверками строкой выше.
  return value as Readonly<Record<string, unknown>>;
}

/** Номер доставки: целое неотрицательное. */
function idOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : undefined;
}

/** Первый кадр канала: ключ сессии. */
export function helloFrame(key: string): string {
  return JSON.stringify({ key });
}

/** Ключ сессии из первого кадра; кадр не тот — `undefined`. */
export function helloKeyOf(text: string): string | undefined {
  const key = fieldsOf(text)?.key;
  return typeof key === "string" && key !== "" ? key : undefined;
}

/** Кадр ядра: канал зарегистрирован — тексты владельца пойдут сюда. */
export const READY_FRAME = JSON.stringify({ ready: true });

/** Кадр ядра: доставить текст `text` под номером `id`. */
export function deliverFrame(id: number, text: string): string {
  return JSON.stringify({ deliver: text, id });
}

/** Чтение кадра ядра каналом. */
export interface CoreFrameReader<T> {
  /** Регистрация принята. */
  ready(): T;
  deliver(id: number, text: string): T;
  /** Кадр не той формы: канал его не понимает. */
  unknown(): T;
}

/** Разбор кадра ядра. */
export function readCoreFrame<T>(text: string, reader: CoreFrameReader<T>): T {
  const fields = fieldsOf(text);
  if (fields?.ready === true) return reader.ready();
  const id = idOf(fields?.id);
  const deliver = fields?.deliver;
  if (id === undefined || typeof deliver !== "string") return reader.unknown();
  return reader.deliver(id, deliver);
}

/** Ответ канала: доставка `id` удалась. */
export function deliveredFrame(id: number): string {
  return JSON.stringify({ delivered: id });
}

/** Ответ канала: доставка `id` не удалась. */
export function failedFrame(id: number): string {
  return JSON.stringify({ failed: id });
}

/** Чтение ответа канала ядром. */
export interface ChannelAnswerReader<T> {
  delivered(id: number): T;
  failed(id: number): T;
  /** Кадр не той формы. */
  unknown(): T;
}

/** Разбор ответа канала. */
export function readChannelAnswer<T>(
  text: string,
  reader: ChannelAnswerReader<T>,
): T {
  const fields = fieldsOf(text);
  const delivered = idOf(fields?.delivered);
  if (delivered !== undefined) return reader.delivered(delivered);
  const failed = idOf(fields?.failed);
  if (failed !== undefined) return reader.failed(failed);
  return reader.unknown();
}
