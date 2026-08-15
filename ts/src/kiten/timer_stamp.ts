/**
 * Метки времени личного таймера (`docs/specs/kiten-time.md`, «Побочные
 * эффекты»): натёкшая длительность и границы, которые `stop` отправляет
 * серверу.
 *
 * Модуль чист — часы приходят параметром. Отдельно от команды он лежит
 * потому, что здесь единственное место, знающее две неочевидности
 * обмена: метки уходят в зоне МОМЕНТА СТАРТА таймера, а не в зоне машины
 * и не в UTC, и миллисекунды в них всегда `.000`
 * (`platform/kaiten-api-time.md`, вызов 7).
 */

/** Минута в миллисекундах — единица длительности во всём учёте времени. */
const MINUTE_MS = 60_000;

/** Зона в хвосте ISO-метки: `Z` либо `±ЧЧ:ММ` (двоеточие необязательно). */
const ZONE_TAIL = /(?:(Z)|([+-])(\d{2}):?(\d{2}))$/;

/**
 * Сдвиг зоны ISO-метки в минутах; `null` — зоны в метке нет и вывести её
 * неоткуда. Вызывающий решает, чем её заменить: угадывать здесь значило
 * бы отправить серверу метку в зоне, которой в ответе не было.
 */
export function zoneOffsetMinutes(iso: string): number | null {
  const tail = ZONE_TAIL.exec(iso);
  if (tail === null) return null;
  if (tail[1] !== undefined) return 0;
  const minutes = Number(tail[3]) * 60 + Number(tail[4]);
  return tail[2] === "-" ? -minutes : minutes;
}

/**
 * Момент как ISO-метка в заданной зоне, с нулевыми миллисекундами:
 * `2026-08-14T19:50:33.000+03:00`. Секунды сохраняются — до целой минуты
 * границы усекает `stop`, и делает это осознанно, а не форматированием.
 */
export function isoAt(atMs: number, offsetMinutes: number): string {
  const local = new Date(
    Math.floor(atMs / 1000) * 1000 + offsetMinutes * MINUTE_MS,
  );
  return `${local.toISOString().slice(0, 23)}${zoneLabel(offsetMinutes)}`;
}

/** Момент, усечённый до целой минуты вниз. */
export function floorToMinute(atMs: number): number {
  return Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
}

/** Момент, сдвинутый на целые минуты. */
export function shiftMinutes(atMs: number, minutes: number): number {
  return atMs + minutes * MINUTE_MS;
}

/**
 * Натёкшая длительность в целых минутах, округление ВВЕРХ — так же, как
 * считает её сервер по разнице меток (`kaiten-api-time.md`, вызов 7).
 * Отрицательная разница (метка старта в будущем) даёт 0: длительности
 * меньше нуля в учёте времени не бывает.
 */
export function elapsedMinutes(fromMs: number, toMs: number): number {
  return Math.max(0, Math.ceil((toMs - fromMs) / MINUTE_MS));
}

/** Хвост зоны ISO-метки: `+03:00`, `-05:30`, `+00:00`. */
function zoneLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const total = Math.abs(offsetMinutes);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}
