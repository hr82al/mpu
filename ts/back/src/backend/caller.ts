/**
 * Кто пришёл — по токену (`cli-client.md`, «Канал и токен»): верить ли
 * его слову «я человек». Номер подтверждения тоже помнит вызывающего:
 * ответ с другим токеном не принимается.
 */

/** Вызывающий строки. */
export interface Caller {
  human(claimed: boolean): boolean;
}

/** Основной токен: `human` из кадра верится. */
export const OWNER: Caller = { human: (claimed) => claimed };

/** Агентский токен: `human` — всегда `false`. */
export const AGENT: Caller = { human: () => false };

/**
 * Браузер с cookie сессии (`specs/web.md`): права основного токена —
 * отдельный вызывающий, чтобы номер подтверждения, выданный браузеру,
 * принимался только от браузера.
 */
export const BROWSER: Caller = { human: (claimed) => claimed };
