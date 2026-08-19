/**
 * Календарная дата местного пояса. Нужна двум командам с разными
 * поводами: дефолт `--date-to` у обёрток над sl-back CLI
 * (`docs/specs/portainer-wrappers.md`) и причина impersonation
 * `ТП <дата>` у поиска (`docs/specs/search.md`).
 *
 * Разряды местные, а не UTC: обе даты человек задаёт по своему
 * календарю, и в поясе восточнее Гринвича UTC-дата отстаёт на сутки до
 * конца рабочего дня.
 */

const MINUTE_MS = 60_000;

/**
 * Дата момента `nowMs` в поясе со смещением `offsetMinutes` — в форме
 * `Date.getTimezoneOffset()`: минуты, которые надо вычесть из локального
 * времени, чтобы получить UTC. Отдельная функция от чтения часов, чтобы
 * правило было проверяемо без подстановки времени машины.
 */
export function localDate(nowMs: number, offsetMinutes: number): string {
  return new Date(nowMs - offsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

/** Сегодняшняя локальная дата машины, `YYYY-MM-DD`. */
export function today(): string {
  const now = new Date();
  return localDate(now.getTime(), now.getTimezoneOffset());
}
