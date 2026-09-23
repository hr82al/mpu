/**
 * Кто пришёл — по токену (`cli-client.md`, «Канал и токен»): верить ли
 * его слову «я человек». Номер подтверждения тоже помнит вызывающего:
 * ответ с другим токеном не принимается.
 */

import { sessionHash } from "./web.ts";

/** Вызывающий строки. */
export interface Caller {
  human(claimed: boolean): boolean;
  /**
   * Как назвать строку этого запроса для памяти результатов
   * (`platform/it.md`). Снимается при приходе запроса: после апгрейда
   * сокета запрос уже закрыт.
   */
  naming(request: Request): Naming;
}

/** Имя строки для памяти результатов. */
export interface Naming {
  /** Имя по `caller` кадра; вызывающего нет — `undefined`. */
  of(claimed: string | undefined): Promise<string | undefined>;
}

/** Строка без вызывающего: её результат не запоминается. */
const NAMELESS: Naming = { of: () => Promise.resolve(undefined) };

/** Клиент называет себя сам: `caller` кадра. */
const CLAIMED: Naming = { of: (claimed) => Promise.resolve(claimed) };

/** Основной токен: `human` из кадра верится. */
export const OWNER: Caller = {
  human: (claimed) => claimed,
  naming: () => CLAIMED,
};

/** Агентский токен: `human` — всегда `false`. */
export const AGENT: Caller = { human: () => false, naming: () => CLAIMED };

/**
 * Браузер с cookie сессии (`specs/web.md`): права основного токена —
 * отдельный вызывающий, чтобы номер подтверждения, выданный браузеру,
 * принимался только от браузера.
 */
export const BROWSER: Caller = {
  human: (claimed) => claimed,
  // Cookie `HttpOnly` — странице не видна: вызывающего называет `back`
  // хэшем сессии, а поле кадра браузера не читается — чужая вкладка
  // подставила бы чужое имя.
  naming(request) {
    const session = cookieOf(request, SESSION_COOKIE);
    // Браузер пускает только cookie сессии; нет её — вызывающего нет, а
    // не общая на всех пустая сессия.
    if (session === undefined) return NAMELESS;
    return { of: async () => `web:${await sessionHash(session)}` };
  },
};

/** Cookie сессии браузера (`specs/web.md`). */
export const SESSION_COOKIE = "mpu_session";

/** Значение cookie `name` из запроса; нет — `undefined`. */
export function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}
