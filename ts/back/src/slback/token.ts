/**
 * Файловый кэш JWT sl-back (`platform/slback-http.md`, «Креды и
 * токен»): разбор записи, её срок годности и сборка новой.
 *
 * Чистые функции над текстом файла, а не работа с диском: файл читает
 * и пишет порт io, а решение «кэш жив / кэша нет» проверяется без
 * файловой системы и без часов стеной.
 */

/** Срок годности записи от момента получения токена. */
export const TOKEN_TTL_SEC = 600;

/**
 * Токен из записи кэша, если она жива. Любая порча — отсутствие файла,
 * битый JSON, не тот тип поля, просрочка — это «кэша нет», а не
 * ошибка: следом идёт обычный логин.
 */
export function cachedToken(
  text: string | undefined,
  nowSec: number,
): string | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const token = record["token"];
  const expiresAt = record["expires_at"];
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    return undefined;
  }
  // Строго `<`: запись, у которой срок наступил ровно сейчас, уже
  // мертва — спека говорит «жива, пока now < expires_at».
  return nowSec < expiresAt ? token : undefined;
}

/** Текст новой записи кэша: тот же формат, что читает `cachedToken`. */
export function tokenCacheText(token: string, nowSec: number): string {
  return JSON.stringify({ token, expires_at: nowSec + TOKEN_TTL_SEC });
}
