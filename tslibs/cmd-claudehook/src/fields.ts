/**
 * Поля объекта JSON из payload'а и транскрипта — после проверки, что это
 * объект: граница чужого формата читает их только так.
 */

/** Поля объекта JSON. */
export type Fields = Readonly<Record<string, unknown>>;

/** Объект ли это (не массив и не `null`). */
export function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
