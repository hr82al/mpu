/**
 * Сегодняшний московский день (`docs/specs/telegram-status.md`,
 * «CLI-контракт»): окно `[00:00:00; 23:59:59]` включительно по обеим
 * границам — в секундах для журнала и в ISO UTC для запроса к Kaiten.
 *
 * Зона взята у команд учёта времени (`kiten/msk.ts`): второй её
 * экземпляр разъехался бы с первым.
 */

import { MSK_OFFSET_MINUTES, mskDay } from "../kiten/msk.ts";

const DAY_SECONDS = 24 * 60 * 60;

/** Границы московского дня в двух формах: журнальной и сетевой. */
export interface DayWindow {
  /** Календарный день МСК, `YYYY-MM-DD`: он стоит в шапке отчёта. */
  readonly day: string;
  /** Начало дня, epoch-секунды. */
  readonly fromSec: number;
  /** Конец дня включительно, epoch-секунды. */
  readonly toSec: number;
  /** Начало дня, ISO-8601 UTC — параметр запроса к Kaiten. */
  readonly fromIso: string;
  /** Конец дня включительно, ISO-8601 UTC. */
  readonly toIso: string;
}

/** Окно сегодняшнего московского дня для момента `nowMs`. */
export function mskDayWindow(nowMs: number): DayWindow {
  const day = mskDay(nowMs);
  const fromMs = Date.parse(`${day}T00:00:00.000Z`) -
    MSK_OFFSET_MINUTES * 60 * 1000;
  const fromSec = fromMs / 1000;
  const toSec = fromSec + DAY_SECONDS - 1;
  return {
    day,
    fromSec,
    toSec,
    fromIso: isoUtc(fromSec),
    toIso: isoUtc(toSec),
  };
}

/** Момент в форме, которую принимает Kaiten: `YYYY-MM-DDThh:mm:ssZ`. */
function isoUtc(atSec: number): string {
  return `${new Date(atSec * 1000).toISOString().slice(0, 19)}Z`;
}
