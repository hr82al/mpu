/**
 * Даты доменных флагов семейства обёрток
 * (`docs/specs/portainer-wrappers.md`): дефолт `--date-to` —
 * сегодняшняя локальная дата, вычисленная в момент вызова.
 *
 * Разряды местные, а не UTC: пересчёт расходов «за период по сегодня»
 * человек задаёт по своему календарю, и в поясе восточнее Гринвича
 * UTC-дата отстаёт на сутки до конца рабочего дня.
 */

import { z } from "@zod/zod";
import type { Flag } from "./inner.ts";

const MINUTE_MS = 60_000;

/** Начало периода по умолчанию — одно на все обёртки семейства. */
const DEFAULT_DATE_FROM = "2025-01-01";

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

/**
 * Входы периода: их объявляют четыре обёртки семейства дословно
 * одинаково (`--date-from`, `--date-to` и snake-написания), поэтому
 * объявление одно. Порядок в inner-команде у всех четырёх тоже один —
 * даты идут первыми среди доменных флагов (таблица спеки).
 */
export const periodArgs = {
  "date-from": z.string().optional().describe(
    "начало периода, YYYY-MM-DD (по умолчанию 2025-01-01)",
  ),
  date_from: z.string().optional().describe("то же, что --date-from"),
  "date-to": z.string().optional().describe(
    "конец периода, YYYY-MM-DD (по умолчанию сегодня)",
  ),
  date_to: z.string().optional().describe("то же, что --date-to"),
};

/** Разобранные входы периода: kebab старше snake-написания. */
export type PeriodArgs = {
  readonly "date-from"?: string;
  readonly date_from?: string;
  readonly "date-to"?: string;
  readonly date_to?: string;
};

/**
 * Флаги периода в порядке спеки. Дефолт `--date-to` берётся здесь, то
 * есть в момент вызова, и всегда уходит явным токеном (инвариант спеки).
 */
export function periodFlags(args: PeriodArgs): readonly Flag[] {
  return [
    {
      name: "date-from",
      value: args["date-from"] ?? args.date_from ?? DEFAULT_DATE_FROM,
    },
    { name: "date-to", value: args["date-to"] ?? args.date_to ?? today() },
  ];
}
