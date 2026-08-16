/**
 * Московская зона команд учёта времени (`docs/specs/kiten-time.md`,
 * «Инварианты»: «сегодня» и часы-минуты в выводе — по МСК).
 *
 * Отдельный модуль, потому что сдвиг зоны нужен и разбору входа
 * (умолчание даты записи), и выводу (часы старта таймера), а второй его
 * экземпляр разъехался бы с первым. Зона фиксирована и перевода часов не
 * знает, поэтому сдвиг — константа, а не запрос к базе часовых поясов.
 */

/** Сдвиг московской зоны в минутах; перевода часов она не знает. */
export const MSK_OFFSET_MINUTES = 3 * 60;

const MSK_OFFSET_MS = MSK_OFFSET_MINUTES * 60 * 1000;

/**
 * Московский календарный день момента. Считается от миллисекунд, а не от
 * локальной зоны машины: та у пользователя может быть любой, а записи
 * компании живут в московском дне.
 */
export function mskDay(nowMs: number = Date.now()): string {
  return new Date(nowMs + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Часы и минуты момента по МСК — `19:50`; секунды в выводе не участвуют. */
export function mskClock(atMs: number): string {
  return new Date(atMs + MSK_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * День с часами по МСК — `14.08 19:50`. Год опущен: метка называет
 * момент старта идущего таймера (`kiten-close.md`), а он не бывает
 * прошлогодним.
 */
export function mskStamp(atMs: number): string {
  const at = new Date(atMs + MSK_OFFSET_MS).toISOString();
  return `${at.slice(8, 10)}.${at.slice(5, 7)} ${at.slice(11, 16)}`;
}
