/**
 * Разбор данных, пришедших по проводу: кадр строки и тело запроса —
 * текст, о котором до разбора известно только, что он текст. Отдельным
 * листом, потому что разбирают его и кадры (`frame.ts`), и контекст
 * вызова (`context.ts`), а два одинаковых правила «что считать
 * объектом» разошлись бы.
 */

/** Разобранный JSON; не строка или не разбирается — `undefined`. */
export function parsedJson(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    // Причина разбора клиенту не нужна: ответ один на все её виды.
    return undefined;
  }
}

/** Объект JSON, а не список и не `null`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
